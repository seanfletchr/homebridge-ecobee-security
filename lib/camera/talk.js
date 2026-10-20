import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';

// Two-way talk: audio from the Home app's live view (and a test tone) to the doorbell's speaker. Both turn into
// Opus RTP on a local port and go to the session's audio sender (session.js, sendTalk). See docs/ecobee-hksv-plan.md.

const SRTP_SUITE = 'AES_CM_128_HMAC_SHA1_80';
// AAC-ELD AudioSpecificConfig HomeKit uses (mono): 16 kHz and 24 kHz.
const ELD_CONFIG = { 16: 'F8F0212C00BC00', 24: 'F8EC212C00BC00' };
const TONE_SECONDS = 3;
const OPUS_PAYLOAD_TYPE = 111;
// A starting return ffmpeg needs this long before it listens; packets in the meantime are held (a few at most).
const START_DELAY = 300;
const MAX_QUEUED = 30;

/** RTCP (sender/receiver reports and friends) has 200 to 204 in the second byte; the marker bit makes it 72 to 76 after masking. */
export function isRtcp(packet) {
  if (packet.length < 2) {
    return false;
  }
  const type = packet[1] & 0x7f;
  return type >= 72 && type <= 76;
}

/**
 * What the camera answered for audio: direction, codec line and fmtp of the first payload type, as plain text.
 * @param {string} sdp the answer
 * @returns {{present: boolean, rejected: boolean, direction: string, codec?: string, fmtp?: string}}
 */
export function parseAudioAnswer(sdp) {
  const lines = String(sdp).split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('m=audio '));
  if (start < 0) {
    return { present: false, rejected: true, direction: 'none' };
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith('m='));
  const media = lines.slice(start, end < 0 ? undefined : end);
  const header = lines.slice(0, start);
  const parts = media[0].split(' ');
  const rejected = parts[1] === '0';
  const direction = [...media, ...header].map(line => /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line)?.[1]).find(Boolean) ?? 'sendrecv';
  const payload = parts[3];
  const codec = media.find(line => payload !== undefined && line.startsWith(`a=rtpmap:${payload} `))?.slice(`a=rtpmap:${payload} `.length);
  const fmtp = media.find(line => payload !== undefined && line.startsWith(`a=fmtp:${payload} `))?.slice(`a=fmtp:${payload} `.length);
  return { present: true, rejected, direction: rejected ? 'inactive' : direction, codec, fmtp };
}

/** The SDP the return audio ffmpeg reads (on stdin): HomeKit's SRTP-protected AAC-ELD, on a local port. */
export function buildReturnSdp({ port, pt, sampleRate, key }) {
  const config = ELD_CONFIG[sampleRate] ?? ELD_CONFIG[16];
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=talk',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${port} RTP/AVP ${pt}`,
    `a=rtpmap:${pt} MPEG4-GENERIC/${sampleRate * 1000}/1`,
    `a=fmtp:${pt} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=${config}`,
    `a=crypto:1 ${SRTP_SUITE} inline:${key.toString('base64')}`,
    '',
  ].join('\r\n');
}

const LOW_LATENCY_IN = ['-fflags', '+nobuffer+discardcorrupt', '-flags', '+low_delay', '-probesize', '2048', '-analyzeduration', '0'];

function opusOut(port) {
  return [
    '-ar', '48000', '-ac', '1', '-c:a', 'libopus', '-application', 'voip', '-frame_duration', '20', '-b:a', '24k',
    '-flush_packets', '1', '-payload_type', String(OPUS_PAYLOAD_TYPE), '-f', 'rtp', `rtp://127.0.0.1:${port}`,
  ];
}

/** ffmpeg arguments: HomeKit's return audio (the SDP on stdin) to Opus RTP at `outPort`. */
export function returnArgs(outPort) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    ...LOW_LATENCY_IN,
    '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
    // ffmpeg's own AAC decoder doesn't do AAC-ELD with SBR (HomeKit's); libfdk_aac, which the live view needs anyway, does.
    '-c:a', 'libfdk_aac', '-f', 'sdp', '-i', 'pipe:0',
    '-vn', ...opusOut(outPort),
  ];
}

/** ffmpeg arguments: a test tone as Opus RTP at `outPort`, in real time. */
export function toneArgs(outPort, seconds = TONE_SECONDS) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-re', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=48000:duration=${seconds}`,
    ...opusOut(outPort),
  ];
}

/** A local UDP socket that ffmpeg's Opus RTP goes to; each packet is handed to `send`. */
function opusReceiver(send) {
  const socket = createSocket('udp4');
  socket.on('error', () => {});
  socket.on('message', (packet) => {
    if (!isRtcp(packet)) {
      send(packet);
    }
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port: 0, address: '127.0.0.1', exclusive: true }, () => resolve({ socket, port: socket.address().port }));
  });
}

function watchStderr(child, log, label) {
  const lines = [];
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) {
        lines.push(line.trim());
        log.debug(`${label} ffmpeg: ${line.trim()}`);
      }
    }
  });
  return lines;
}

/**
 * Play a test tone on the doorbell's speaker.
 * @param {object} p
 * @param {string} p.ffmpegPath
 * @param {(packet: Buffer) => boolean} p.send hands an Opus RTP packet to the doorbell; false = it wasn't taken
 * @returns {Promise<{sent: number, refused: number}>}
 */
export async function playTestTone({ ffmpegPath, send, log, name }) {
  let sent = 0;
  let refused = 0;
  const { socket, port } = await opusReceiver((packet) => {
    if (send(packet)) {
      sent++;
    } else {
      refused++;
    }
  });
  const args = toneArgs(port);
  log.debug(`"${name}" test tone: ffmpeg ${args.join(' ')}`);
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const lines = watchStderr(child, log, `"${name}" test tone`);
  const timeout = setTimeout(() => child.kill('SIGKILL'), (TONE_SECONDS + 5) * 1000);
  return new Promise((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      // The last packets may still be on their way through the socket.
      setTimeout(() => {
        socket.close();
        if (code === 0) {
          resolve({ sent, refused });
        } else {
          reject(new Error(`ffmpeg stopped (${code}) ${lines.at(-1) ?? ''}`.trim()));
        }
      }, 100);
    });
  });
}

/**
 * The return audio of one live view. Owns the audio port HomeKit was given: HomeKit's RTCP goes on to the live view's
 * ffmpeg, its RTP (the microphone) to a second ffmpeg that turns it into Opus, and from there to the doorbell.
 */
export class ReturnAudio {
  /**
   * @param {object} p
   * @param {string} p.ffmpegPath
   * @param {number} p.localPort the port HomeKit sends to
   * @param {number} p.rtcpPort where the live view's ffmpeg listens for RTCP
   * @param {number} p.rtpPort a free local port for the return ffmpeg to listen on
   * @param {object} p.audio HomeKit's audio settings from the start request (pt, sample_rate)
   * @param {Buffer} p.key SRTP master key and salt
   * @param {(packet: Buffer) => boolean} p.send hands an Opus RTP packet to the doorbell
   */
  constructor({ ffmpegPath, localPort, rtcpPort, rtpPort, audio, key, send, log, name }) {
    Object.assign(this, { ffmpegPath, localPort, rtcpPort, rtpPort, audio, key, send, log, name });
    this.stopped = false;
    this.micPackets = 0;
    this.rtcpPackets = 0;
    this.sent = 0;
    this.refused = 0;
    this.starts = 0;
    this.queue = undefined;
    this.socket = undefined;
    this.opus = undefined;
    this.child = undefined;
  }

  /** Bind the port. The return ffmpeg is started by the first microphone packet (see demux). Throws if the port can't be had. */
  async start() {
    // A live view that restarts uses the same port; the old socket may take a moment to let go of it.
    for (let attempt = 1; !this.socket; attempt++) {
      const socket = createSocket('udp4');
      socket.on('error', () => {});
      try {
        await new Promise((resolve, reject) => {
          socket.once('error', reject);
          socket.bind({ port: this.localPort, exclusive: true }, resolve);
        });
        this.socket = socket;
      } catch (error) {
        socket.close();
        if (attempt >= 4) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try {
      this.opus = await opusReceiver((packet) => {
        if (this.send(packet)) {
          this.sent++;
        } else {
          this.refused++;
        }
      });
    } catch (error) {
      this.stop();
      throw error;
    }
    this.socket.on('message', packet => this.demux(packet));
  }

  /**
   * Start the return ffmpeg. HomeKit stops sending while the microphone is off and ffmpeg's input then times out, so it
   * runs only while someone talks: the next microphone packet starts it again, and the few packets that arrive while it
   * starts are held back and sent once it listens.
   */
  startFfmpeg() {
    const args = returnArgs(this.opus.port);
    this.log.debug(`"${this.name}" talk: ffmpeg ${args.join(' ')}`);
    const child = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.child = child;
    this.starts++;
    this.queue = [];
    child.stdin.on('error', () => {});
    child.stdin.end(buildReturnSdp({
      port: this.rtpPort, pt: this.audio.pt, sampleRate: this.audio.sample_rate, key: this.key,
    }));
    const lines = watchStderr(child, this.log, `"${this.name}" talk`);
    const ready = setTimeout(() => {
      if (this.child === child) {
        const queued = this.queue;
        this.queue = undefined;
        queued.forEach(packet => this.socket.send(packet, this.rtpPort, '127.0.0.1', () => {}));
      }
    }, START_DELAY);
    let gone = false;
    const done = (text, idleOk) => {
      if (gone) {
        return;
      }
      gone = true;
      clearTimeout(ready);
      if (this.child === child) {
        this.child = undefined;
        this.queue = undefined;
      }
      if (!this.stopped) {
        const idle = idleOk && /timed out/i.test(lines.at(-1) ?? '');
        this.log[idle ? 'debug' : 'warn'](`"${this.name}" talk: ffmpeg stopped (${text}${lines.at(-1) ? `: ${lines.at(-1)}` : ''})`
          + `${idle ? '; it starts again with the next microphone packet.' : '.'}`);
      }
    };
    child.on('error', error => done(`could not run: ${error.message}`, false));
    child.on('exit', (code, signal) => done(String(signal ?? code), true));
  }

  /** RTCP goes to the live view's ffmpeg, RTP (the microphone) to the return ffmpeg. */
  demux(packet) {
    if (this.stopped) {
      return;
    }
    if (isRtcp(packet)) {
      this.rtcpPackets++;
      this.socket.send(packet, this.rtcpPort, '127.0.0.1', () => {});
      return;
    }
    if (++this.micPackets === 1) {
      this.log.info(`"${this.name}" talk: the Home app is sending microphone audio.`);
    }
    if (!this.child) {
      this.startFfmpeg();
    }
    if (this.queue) {
      if (this.queue.length < MAX_QUEUED) {
        this.queue.push(packet);
      }
      return;
    }
    this.socket.send(packet, this.rtpPort, '127.0.0.1', () => {});
  }

  stop() {
    this.stopped = true;
    this.child?.kill('SIGKILL');
    for (const socket of [this.socket, this.opus?.socket]) {
      try {
        socket?.close();
      } catch {
        // already closed
      }
    }
  }
}
