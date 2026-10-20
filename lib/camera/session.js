import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';

import { SignInRequiredError } from '../ecobee.js';
import { JitterBuffer } from './jitter.js';
import { Depacketizer, annexB } from './h264.js';
import { parseAudioAnswer } from './talk.js';

// Live view signalling (GraphQL, the same cloud and sign-in as the rest of the plugin) and a WebRTC
// peer on the LAN. See docs/api.md, "Doorbell / camera".
const ICE_QUERY = 'query IceServers { user { iceServers { username credential serverUris } } }';
const OFFER_MUTATION = 'mutation InitiateLiveVideoOfferForCamera($input: InitiateLiveVideoOfferForCameraInput!) { '
  + 'initiateLiveVideoOfferForCamera(input: $input) { sessionDescriptionProtocolAnswer } }';
const CANDIDATE_MUTATION = 'mutation SendIceCandidateForCamera($input: SendIceCandidateForCameraInput!) { '
  + 'sendIceCandidateForCamera(input: $input) { errors } }';

const RECONNECT_AFTER = 5 * 1000;
const MIN_START_GAP = 30 * 1000;
const MAX_BACKOFF = 5 * 60 * 1000;
const STALL_AFTER = 15 * 1000;
const NO_MEDIA_AFTER = 30 * 1000;
const PLI_GAP = 4000;
// No keyframe for this long: ask for one (a PLI, never more often than every 4 s, and after two that went unanswered not
// again until a keyframe has come: asking a lot made the camera's stream worse). Live views and snapshots want keyframes;
// recordings don't, they are re-encoded.
const KEYFRAME_AFTER = 4000;
const CANDIDATE_BATCH = 200;
const STATS_EVERY = 60 * 1000;
// With two-way talk on, the first stats line comes early and at info level, so one live run shows whether the audio sender works.
const FIRST_STATS_AFTER = 10 * 1000;
// Talk packets further apart than this start a new burst: the RTP timestamp jumps by the real time, the marker bit is set.
const TALK_GAP = 100;
const TALK_FRAME = 960;
// How long setup waits for werift to take the answer before carrying on (two-way talk only).
const SET_REMOTE_WAIT = 5000;

const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');

/** Find a key anywhere in a (small) response. */
function findKey(obj, key) {
  if (obj && typeof obj === 'object') {
    if (key in obj) {
      return obj[key];
    }
    for (const value of Object.values(obj)) {
      const found = findKey(value, key);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * One always-on WebRTC live view session to an ecobee camera.
 *
 * Events: `rtp` ({kind: 'video' | 'audio', packet: Buffer}, in sequence order), `state`
 * ('connected' | 'disconnected').
 */
export class DoorbellSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../ecobee.js').EcobeeCloud} options.cloud
   * @param {string} options.cameraId
   * @param {string} [options.name] for the log
   * @param {import('homebridge').Logging} options.log
   * @param {boolean} [options.twoWayAudio] offer audio as send and receive, so audio can go to the doorbell's speaker
   */
  constructor({ cloud, cameraId, name = 'Doorbell', log, twoWayAudio = false }) {
    super();
    this.twoWayAudio = twoWayAudio === true;
    this.cloud = cloud;
    this.cameraId = cameraId;
    this.name = name;
    this.log = log;
    this.stopped = false;
    this.connected = false;
    this.signedOut = false;
    this.downSince = Date.now();
    this.lastStart = 0;
    this.failures = 0;
    this.reconnectTimer = undefined;
    this.attempt = undefined;
    this.sinks = new Set();
    this.socket = undefined;
    /** @type {{data: Buffer, at: number} | undefined} the newest complete keyframe, as Annex-B with SPS and PPS */
    this.latestKeyframe = undefined;
    this.sps = undefined;
    this.pps = undefined;
    this.lastPli = 0;
    // Running totals across reconnects; a live view reports the difference between its start and end.
    this.counters = { videoPackets: 0, videoSkipped: 0, audioPackets: 0, audioSkipped: 0, audioGaps: 0, keyframeRequests: 0 };
    this.unansweredPli = 0;
  }

  /** Start (and keep) the session. */
  start() {
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.attempt?.end('stopped');
    this.socket?.close();
    this.socket = undefined;
    this.sinks.clear();
  }

  /** How long the session has been down (ms); 0 while it's up. */
  downFor() {
    return this.connected ? 0 : Date.now() - this.downSince;
  }

  /** Did the camera accept audio from us (it answered send and receive) on the running session? */
  get talkReady() {
    return this.connected && this.attempt?.talkAccepted === true;
  }

  /**
   * Send one Opus RTP packet (any sequence numbers and timestamps; they are renumbered) to the doorbell's speaker.
   * @returns {boolean} false if the camera doesn't take audio or the session isn't up
   */
  sendTalk(packet) {
    return this.talkReady && this.attempt.sendTalk(packet);
  }

  /** SPS/PPS of the stream as seen so far (base64, for an SDP), if both are known. */
  get sprop() {
    return this.sps && this.pps ? `${this.sps.toString('base64')},${this.pps.toString('base64')}` : undefined;
  }

  /**
   * Ask the camera for a keyframe: not more often than every 4 s, and after two requests nobody answered, only when
   * `force` says someone is waiting for the picture (a live view starting).
   */
  requestKeyframe(force = false) {
    const now = Date.now();
    const attempt = this.attempt;
    if (now - this.lastPli < PLI_GAP || !attempt || attempt.videoSsrc === undefined || !attempt.video) {
      return false;
    }
    if (!force && this.unansweredPli >= 2) {
      return false;
    }
    this.lastPli = now;
    this.unansweredPli++;
    this.counters.keyframeRequests++;
    Promise.resolve(attempt.video.receiver?.sendRtcpPLI?.(attempt.videoSsrc)).catch(() => {});
    return true;
  }

  /**
   * Forward the ordered RTP to 127.0.0.1 ports (one per kind, either may be left out).
   * @returns {() => void} removes the sink
   */
  addSink({ videoPort, audioPort }) {
    if (!this.socket) {
      this.socket = createSocket('udp4');
      this.socket.on('error', () => {});
    }
    const sink = { videoPort, audioPort };
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  forward(kind, packet) {
    this.emit('rtp', { kind, packet });
    for (const sink of this.sinks) {
      const port = kind === 'video' ? sink.videoPort : sink.audioPort;
      if (port) {
        this.socket?.send(packet, port, '127.0.0.1', () => {});
      }
    }
  }

  setConnected(connected) {
    if (connected === this.connected) {
      return;
    }
    this.connected = connected;
    if (!connected) {
      this.downSince = Date.now();
    }
    this.emit('state', connected ? 'connected' : 'disconnected');
  }

  schedule(delay) {
    clearTimeout(this.reconnectTimer);
    if (this.stopped) {
      return;
    }
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  async connect() {
    if (this.stopped) {
      return;
    }
    this.lastStart = Date.now();
    const attempt = new Attempt(this);
    this.attempt = attempt;
    try {
      await attempt.setup();
    } catch (error) {
      if (error instanceof SignInRequiredError) {
        this.signedOut = true;
      }
      attempt.end(`setup failed: ${error.message}`);
      return;
    }
    this.signedOut = false;
  }

  /** An attempt ended: say why, and line up the next one. */
  attemptEnded(attempt, reason) {
    if (attempt !== this.attempt) {
      return;
    }
    this.attempt = undefined;
    this.setConnected(false);
    const hadMedia = attempt.firstVideoAt > 0;
    this.failures = hadMedia ? 0 : this.failures + 1;
    const seconds = Math.round((Date.now() - attempt.startedAt) / 1000);
    // Time between starts: never less than 30 s, growing up to 5 min while setting up keeps failing.
    const backoff = this.failures > 1 ? Math.min(MAX_BACKOFF, MIN_START_GAP * 2 ** (this.failures - 1)) : MIN_START_GAP;
    const delay = Math.max(RECONNECT_AFTER, this.lastStart + backoff - Date.now());
    if (this.stopped) {
      return;
    }
    const line = `"${this.name}" live view session ended after ${seconds} s (${reason}); reconnecting in ${Math.round(delay / 1000)} s.`;
    if (hadMedia) {
      this.log.info(line);
    } else {
      this.log.warn(line);
    }
    this.schedule(delay);
  }
}

/** One WebRTC attempt, from offer to end. */
export class Attempt {
  constructor(session) {
    this.session = session;
    this.log = session.log;
    this.startedAt = Date.now();
    this.ended = false;
    this.pc = undefined;
    this.video = undefined;
    this.videoSsrc = undefined;
    this.firstVideoAt = 0;
    this.lastVideoAt = 0;
    this.queue = [];
    this.flushTimer = undefined;
    this.offerSent = false;
    this.timers = [];
    this.stats = { videoPackets: 0, audioPackets: 0, skippedVideo: 0, skippedAudio: 0, frames: 0, keyframes: 0 };
    // Two-way talk: what the camera answered for audio, and the numbering of what we send.
    this.audio = undefined;
    this.audioAnswer = undefined;
    this.talkAccepted = false;
    this.talk = { sent: 0, errors: 0, seq: Math.floor(Math.random() * 0x10000), ts: Math.floor(Math.random() * 0x100000000), at: 0, rtcp: 0 };
    this.sessionId = randomUUID().toUpperCase();
    this.depacketizer = new Depacketizer(
      (nals) => this.onFrame(nals),
      (lost, dropped, wasKeyframe) => {
        if (lost || dropped) {
          this.needKeyframe = true;
        }
        // A damaged keyframe, or any damaged frame while a keyframe is overdue: ask at once.
        if (dropped && (wasKeyframe || this.keyframeOverdue())) {
          session.requestKeyframe();
        }
      },
    );
    this.needKeyframe = true;
    let lastAudio;
    const forward = kind => packet => {
      if (!this.ended) {
        if (kind === 'audio') {
          // In sequence but a jump in time: the camera itself left something out (or went quiet).
          const { sequenceNumber: seq, timestamp } = packet.header;
          if (lastAudio && seq === ((lastAudio.seq + 1) & 0xffff)) {
            const step = (timestamp - lastAudio.timestamp) >>> 0;
            if (step > 1920 + 480 && step < 48000 * 10) {
              session.counters.audioGaps++;
            }
          }
          lastAudio = { seq, timestamp };
        }
        session.forward(kind, packet.serialize());
        if (kind === 'video') {
          this.depacketizer.push(packet);
        }
      }
    };
    this.videoJitter = new JitterBuffer({
      onPacket: forward('video'),
      onSkip: (count) => {
        this.stats.skippedVideo += count;
        session.counters.videoSkipped += count;
        session.requestKeyframe();
      },
    });
    this.audioJitter = new JitterBuffer({
      onPacket: forward('audio'),
      onSkip: (count) => {
        this.stats.skippedAudio += count;
        session.counters.audioSkipped += count;
      },
    });
  }

  /** Setup progress, at info level while two-way talk is on (one live run then shows where setup stops). */
  step(text) {
    this.log[this.session.twoWayAudio ? 'info' : 'debug'](`"${this.session.name}" setup (${((Date.now() - this.startedAt) / 1000).toFixed(1)} s): ${text}`);
  }

  async setup() {
    const { cloud, cameraId } = this.session;
    this.step('asking ecobee for ICE servers');
    const iceData = await cloud.graphql('IceServers', ICE_QUERY);
    // The camera is on the LAN: UDP STUN/TURN is enough, and TCP/TLS relays only slow a failure down.
    const iceServers = (iceData.user?.iceServers ?? []).map(s => ({
      urls: (s.serverUris ?? []).filter(u => !/^turns:|transport=tcp/i.test(u)),
      username: s.username,
      credential: s.credential,
    })).filter(s => s.urls.length);

    const pc = new RTCPeerConnection({
      iceUseIpv4: true,
      iceUseIpv6: false,
      bundlePolicy: 'max-bundle',
      iceServers,
      codecs: {
        audio: [new RTCRtpCodecParameters({
          mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111,
          rtcpFeedback: [{ type: 'nack' }], parameters: 'minptime=10;useinbandfec=1',
        })],
        video: [new RTCRtpCodecParameters({
          mimeType: 'video/H264', clockRate: 90000, payloadType: 102,
          rtcpFeedback: [{ type: 'ccm', parameter: 'fir' }, { type: 'nack' }, { type: 'nack', parameter: 'pli' }],
          parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
        })],
      },
    });
    this.pc = pc;

    pc.iceConnectionStateChange.subscribe((state) => {
      this.log.debug(`"${this.session.name}" ICE state: ${state}`);
      if (state === 'failed' || state === 'closed') {
        this.end(`ICE ${state}`);
      } else if (state === 'disconnected') {
        setTimeout(() => {
          if (!this.ended && pc.iceConnectionState === 'disconnected') {
            this.end('ICE disconnected for 10 s');
          }
        }, 10 * 1000);
      }
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed') {
        this.end('connection failed');
      }
    });
    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        this.queueCandidate(candidate);
      }
    });

    // The app opens a data channel too; the camera's answer expects the m-line.
    const channel = pc.createDataChannel('data');
    channel.onMessage.subscribe(() => {});
    pc.onDataChannel.subscribe(() => {});

    const audio = pc.addTransceiver('audio', { direction: this.session.twoWayAudio ? 'sendrecv' : 'recvonly' });
    this.audio = audio;
    audio.sender?.onRtcp?.subscribe(() => {
      this.talk.rtcp++;
    });
    const video = pc.addTransceiver('video', { direction: 'recvonly' });
    this.video = video;
    audio.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((packet) => {
        this.stats.audioPackets++;
        this.session.counters.audioPackets++;
        this.audioJitter.push(packet.header.sequenceNumber, packet);
      });
    });
    video.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((packet) => {
        this.lastVideoAt = Date.now();
        this.videoSsrc = packet.header.ssrc;
        if (!this.firstVideoAt) {
          this.firstVideoAt = this.lastVideoAt;
          this.session.failures = 0;
          this.onConnected();
          this.log.debug(`"${this.session.name}" first video packet after ${((this.lastVideoAt - this.startedAt) / 1000).toFixed(1)} s`);
        }
        this.stats.videoPackets++;
        this.session.counters.videoPackets++;
        this.videoJitter.push(packet.header.sequenceNumber, packet);
      });
    });

    await pc.setLocalDescription(await pc.createOffer());
    this.step(`offer made (audio ${this.session.twoWayAudio ? 'sendrecv' : 'recvonly'}), sending it`);
    if (this.ended) {
      return;
    }
    const data = await cloud.graphql('InitiateLiveVideoOfferForCamera', OFFER_MUTATION, {
      input: {
        cameraId,
        sessionDescriptionProtocolInformation: b64({ type: 'offer', sdp: pc.localDescription.sdp }),
        webrtcSessionId: this.sessionId,
      },
    });
    const answer = findKey(data, 'sessionDescriptionProtocolAnswer');
    if (!answer) {
      throw new Error('ecobee sent no answer');
    }
    if (this.ended) {
      return;
    }
    const { sdp } = JSON.parse(Buffer.from(answer, 'base64').toString('utf8'));
    this.step(`answer received (${sdp.length} bytes)`);
    this.offerSent = true;
    this.flushSoon();
    if (this.session.twoWayAudio) {
      // Before werift gets the answer, so that a hang inside it can't hide what the camera said.
      this.checkTalkAnswer(sdp);
    }
    const remoteSet = pc.setRemoteDescription({ type: 'answer', sdp });
    if (this.session.twoWayAudio) {
      // werift's connect() isn't awaited by setRemoteDescription, so media can flow even if this promise stays pending:
      // carry on after a while rather than leave the watchdog and stats unstarted.
      const outcome = await Promise.race([
        remoteSet.then(() => 'done'),
        new Promise(resolve => setTimeout(resolve, SET_REMOTE_WAIT, 'timeout')),
      ]);
      if (outcome === 'timeout') {
        this.log.warn(`"${this.session.name}" setup: setRemoteDescription is still pending after ${SET_REMOTE_WAIT / 1000} s; carrying on.`);
        remoteSet.then(() => this.step('setRemoteDescription finished late'), error => this.end(`setRemoteDescription failed: ${error.message}`));
      }
    } else {
      await remoteSet;
    }
    this.step('remote description set');
    if (this.ended) {
      return;
    }

    this.timers.push(setInterval(() => this.watchdog(), 1000));
    this.timers.push(setInterval(() => this.statsLine(), STATS_EVERY));
    if (this.session.twoWayAudio) {
      this.timers.push(setTimeout(() => this.statsLine(true), FIRST_STATS_AFTER));
    }
  }

  /** Two-way talk: say what the camera answered for audio, once, and whether it takes audio from us. */
  checkTalkAnswer(sdp) {
    const { name } = this.session;
    const answer = parseAudioAnswer(sdp);
    this.audioAnswer = answer;
    this.talkAccepted = answer.present && answer.direction === 'sendrecv';
    this.log.info(`"${name}" two-way talk: the camera answered audio ${answer.direction}`
      + `, codec ${answer.codec ?? 'unknown'}${answer.fmtp ? `, fmtp ${answer.fmtp}` : ''}.`);
    if (!this.talkAccepted) {
      this.log.warn(`"${name}" two-way talk: the camera doesn't accept audio from us (it answered ${answer.direction}); `
        + 'running receive-only, so talking and the test tone do nothing.');
    }
  }

  /** One Opus RTP packet from a local encoder to the camera. The numbering is ours, so sources can follow each other. */
  sendTalk(packet) {
    const sender = this.audio?.sender;
    if (this.ended || !this.talkAccepted || !sender || packet.length < 13) {
      return false;
    }
    const talk = this.talk;
    const now = Date.now();
    const gap = talk.at > 0 && now - talk.at > TALK_GAP;
    const out = Buffer.from(packet);
    talk.seq = (talk.seq + 1) & 0xffff;
    talk.ts = (talk.ts + (talk.at === 0 || !gap ? TALK_FRAME : Math.round((now - talk.at) * 48))) >>> 0;
    talk.at = now;
    out.writeUInt16BE(talk.seq, 2);
    out.writeUInt32BE(talk.ts, 4);
    // A new burst of speech (or the first packet) carries the marker bit.
    out[1] = (out[1] & 0x7f) | (gap || talk.sent === 0 ? 0x80 : 0);
    talk.sent++;
    Promise.resolve(sender.sendRtp(out)).catch((error) => {
      if (talk.errors++ === 0) {
        this.log.warn(`"${this.session.name}" two-way talk: sending to the camera failed: ${error.message}`);
      }
    });
    return true;
  }

  /** The audio sender in one phrase, for the stats line. */
  talkState() {
    if (!this.session.twoWayAudio) {
      return 'off';
    }
    const talk = this.talk;
    return this.talkAccepted
      ? `active (camera accepted sendrecv; sender payload type ${this.audio?.sender?.codec?.payloadType ?? 'none'}; ${talk.sent} packets sent, ${talk.errors} failed, ${talk.rtcp} RTCP back)`
      : `inactive (camera answered ${this.audioAnswer?.direction ?? 'nothing yet'})`;
  }

  onConnected() {
    if (this.connectedLogged) {
      return;
    }
    this.connectedLogged = true;
    this.session.setConnected(true);
    this.pairType().then((type) => {
      this.log.info(`"${this.session.name}" live view session up${type ? ` (${type})` : ''}.`);
    });
  }

  /** Candidate types of the selected pair, like "host" (LAN) or "relay". */
  async pairType() {
    try {
      const report = await this.pc.getStats();
      const all = [...report.values()];
      const pair = all.find(e => e.type === 'candidate-pair' && e.nominated)
        ?? all.find(e => e.type === 'candidate-pair' && e.state === 'succeeded');
      const local = all.find(e => e.id === pair?.localCandidateId)?.candidateType;
      const remote = all.find(e => e.id === pair?.remoteCandidateId)?.candidateType;
      if (!local || !remote) {
        return undefined;
      }
      return local === remote ? local : `${local}/${remote}`;
    } catch {
      return undefined;
    }
  }

  queueCandidate(candidate) {
    this.queue.push(b64({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? '0',
      sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
      serverUrl: candidate.serverUrl ?? '',
    }));
    this.flushSoon();
  }

  /** Candidates go to ecobee in batches, like the app does. */
  flushSoon() {
    if (!this.offerSent || this.flushTimer || !this.queue.length) {
      return;
    }
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = undefined;
      const batch = this.queue.splice(0);
      if (!batch.length || this.ended) {
        return;
      }
      try {
        const reply = await this.session.cloud.graphql('SendIceCandidateForCamera', CANDIDATE_MUTATION, {
          input: { cameraId: this.session.cameraId, candidate: b64(batch), webrtcSessionId: this.sessionId },
        });
        if (reply?.sendIceCandidateForCamera?.errors?.length) {
          this.log.debug(`"${this.session.name}" ecobee refused a candidate batch.`);
        }
      } catch (error) {
        this.log.debug(`"${this.session.name}" sending candidates failed: ${error.message}`);
      }
    }, CANDIDATE_BATCH);
  }

  onFrame(nals) {
    this.stats.frames++;
    let key = false;
    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === 5) {
        key = true;
      } else if (type === 7) {
        this.session.sps = nal;
      } else if (type === 8) {
        this.session.pps = nal;
      }
    }
    if (key) {
      this.stats.keyframes++;
      this.lastKeyAt = Date.now();
      this.session.unansweredPli = 0;
      this.needKeyframe = false;
      this.session.latestKeyframe = { data: annexB(nals, this.session.sps, this.session.pps), at: Date.now() };
    } else if (this.needKeyframe && !this.session.latestKeyframe) {
      this.session.requestKeyframe();
    }
  }

  keyframeOverdue(now = Date.now()) {
    return Boolean(this.firstVideoAt) && now - (this.lastKeyAt || this.firstVideoAt) > KEYFRAME_AFTER;
  }

  /** Keeps keyframes coming for live views: overdue -> a PLI (see requestKeyframe for how often). */
  keepKeyframes(now) {
    if (this.keyframeOverdue(now) && this.session.requestKeyframe()) {
      this.log.debug(`"${this.session.name}" no keyframe for ${((now - (this.lastKeyAt || this.firstVideoAt)) / 1000).toFixed(1)} s: asked for one `
        + `(${this.session.unansweredPli} unanswered).`);
    }
  }

  watchdog() {
    if (this.ended) {
      return;
    }
    const now = Date.now();
    this.keepKeyframes(now);
    if (this.firstVideoAt) {
      if (now - this.lastVideoAt > STALL_AFTER) {
        this.end('no video for 15 s');
      }
    } else if (now - this.startedAt > NO_MEDIA_AFTER) {
      this.end('no media 30 s after start');
    }
  }

  statsLine(first = false) {
    const s = this.stats;
    this.log[first ? 'info' : 'debug'](`"${this.session.name}" live view: up ${Math.round((Date.now() - this.startedAt) / 1000)} s, `
      + `video ${s.videoPackets} packets (${s.skippedVideo} skipped, ${this.videoJitter.recovered} recovered late, ${this.videoJitter.late} too late), `
      + `${s.frames} frames (${s.keyframes} key), audio ${s.audioPackets} packets (${s.skippedAudio} skipped), audio sender ${this.talkState()}, `
      + `keyframe requests ${this.session.counters.keyframeRequests}, `
      + `rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
  }

  end(reason) {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.timers.forEach(clearInterval);
    clearTimeout(this.flushTimer);
    this.videoJitter.reset();
    this.audioJitter.reset();
    Promise.resolve(this.pc?.close()).catch(() => {});
    this.session.attemptEnded(this, reason);
  }
}
