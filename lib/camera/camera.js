import { execFile, spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';

import { MediaBuffer } from './buffer.js';
import { HksvRecorder, recordingOptions } from './recorder.js';
import { ReturnAudio, playTestTone } from './talk.js';

// A HomeKit camera for an ecobee doorbell: live view and snapshots from the always-on session
// (session.js). ffmpeg copies the camera's H.264 straight through and turns its Opus audio into the
// AAC-ELD HomeKit wants.

const SNAPSHOT_CACHE = 2000;
const SNAPSHOT_TIMEOUT = 8000;
const OFFLINE_AFTER = 60 * 1000;
const CHECK_EVERY = 5 * 1000;
// A decoder's own message (or ffmpeg's note that it repeated one), like "[h264 @ 0x7f95802420] error while decoding MB".
const DECODER_LINE = /^(Last message repeated \d+ times|mmco: |illegal short term|Missing reference|reference picture|co located POCs|concealing|error while decoding|.*Error parsing Opus packet header|.*RTP: PT=\w+: bad cseq)|^\[(h264|hevc|opus|libopus|aac|libfdk_aac|mpeg4|vp8|vp9|pcm_[a-z0-9_]+) @ 0x/i;
// How long a doorbell press counts as motion, and how long a motion event from ecobee's cloud does.
// Our motion (the "motion grace period" setting) stays on this long after the doorbell's own motion (or a press) ended, so that one visit
// is one motion and one recording. Events from ecobee's cloud are fresh for 30 s.
const DEFAULT_GRACE = 15 * 1000;
// New motion right after we reported "over" is held back while a recording stream is still open (HomeKit would
// start a second, unplayable event in that stream), for at most this long.
const MOTION_GATE = 10 * 1000;
const POLLED_MOTION = 30 * 1000;
const POLL_EVERY = 5 * 1000;
// The picture is the camera's own (portrait 1200x1600, copied as it is); HomeKit picks a size from this
// list and the ffmpeg commands ignore it.
const RESOLUTIONS = [
  [1200, 1600, 30], [1200, 1600, 15], [960, 1280, 30], [720, 960, 30], [480, 640, 30],
  [1920, 1080, 30], [1280, 960, 30], [1280, 720, 30], [1024, 768, 30], [640, 480, 30], [640, 360, 30],
  [480, 360, 30], [480, 270, 30], [320, 240, 30], [320, 240, 15], [320, 180, 30], [320, 180, 15],
];
// What recordings may be made at (the video is re-encoded to it, fitted into the size): the camera's own first.
const RECORDING_RESOLUTIONS = [
  [1200, 1600, 30], [1200, 1600, 15], [960, 1280, 30], [720, 960, 30], [480, 640, 30],
  [1280, 960, 30], [1280, 720, 30], [640, 480, 30], [640, 360, 30],
];
const SRTP_SUITE = 'AES_CM_128_HMAC_SHA1_80';

/** Does this ffmpeg exist, and can it make the AAC-ELD audio HomeKit needs? */
export function checkFfmpeg(ffmpegPath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 10000 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, reason: `can't run ${ffmpegPath} (${error.code ?? error.message})` });
      } else if (!/\blibfdk_aac\b/.test(stdout)) {
        resolve({ ok: false, reason: `${ffmpegPath} has no libfdk_aac encoder` });
      } else if (!/\blibx264\b/.test(stdout)) {
        resolve({ ok: false, reason: `${ffmpegPath} has no libx264 encoder` });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/** Free local UDP ports for ffmpeg to listen on: `count` of them, even, and no two next to each other (RTCP takes port + 1). */
export async function allocatePorts(count) {
  const ports = [];
  while (ports.length < count) {
    const port = await probe();
    if (port % 2 === 0 && !ports.some(p => Math.abs(p - port) < 2) && await free(port + 1)) {
      ports.push(port);
    }
  }
  return ports;
}

function probe() {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.bind({ port: 0, address: '127.0.0.1', exclusive: true }, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

function free(port) {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.once('error', () => resolve(false));
    socket.bind({ port, address: '127.0.0.1', exclusive: true }, () => socket.close(() => resolve(true)));
  });
}

/** The SDP ffmpeg reads (on stdin) to receive the forwarded RTP. */
export function buildSdp({ videoPort, audioPort, sprop }) {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=ecobee',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=video ${videoPort} RTP/AVP 102`,
    'a=rtpmap:102 H264/90000',
    `a=fmtp:102 packetization-mode=1;profile-level-id=42e01f${sprop ? `;sprop-parameter-sets=${sprop}` : ''}`,
    `m=audio ${audioPort} RTP/AVP 111`,
    'a=rtpmap:111 opus/48000/2',
    '',
  ].join('\r\n');
}

/**
 * ffmpeg arguments for one live view.
 * @param {object} p
 * @param {object} p.hap the HAP module
 * @param {object} p.request HomeKit's start request
 * @param {object} p.stream what prepareStream kept (address, ports, keys, SSRCs); `audioRtcpPort`, if set, is the port ffmpeg
 *   sends its audio RTCP from (and listens on) instead of `localAudioPort`, which return audio then owns (talk.js)
 */
export function liveArgs({ hap, request, stream }) {
  const { video, audio } = request;
  const srtp = key => key.toString('base64');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-fflags', '+genpts', '-reorder_queue_size', '0', '-analyzeduration', '1000000', '-probesize', '200000',
    '-protocol_whitelist', 'pipe,udp,rtp,file',
    '-f', 'sdp', '-i', 'pipe:0',
    // Video: the camera's H.264 as it is, SPS/PPS repeated at each keyframe.
    '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'dump_extra=freq=keyframe',
    '-payload_type', String(video.pt), '-ssrc', String(stream.videoSsrc),
    '-f', 'rtp', '-srtp_out_suite', SRTP_SUITE, '-srtp_out_params', srtp(stream.videoKey),
    `srtp://${stream.address}:${stream.videoPort}?rtcpport=${stream.videoPort}&localrtcpport=${stream.localVideoPort}&pkt_size=${video.mtu}`,
    // Audio: Opus to AAC-ELD (or Opus, if HomeKit asks for it).
    '-map', '0:a:0',
  ];
  if (audio.codec === hap.AudioStreamingCodecType.OPUS) {
    args.push('-c:a', 'libopus', '-application', 'lowdelay', '-frame_duration', String(audio.packet_time));
  } else {
    args.push('-c:a', 'libfdk_aac', '-profile:a', 'aac_eld');
  }
  args.push(
    '-filter:a', 'aresample=async=1:first_pts=0',
    '-flags', '+global_header',
    '-ac', String(audio.channel), '-ar', `${audio.sample_rate}k`, '-b:a', `${audio.max_bit_rate}k`,
    '-payload_type', String(audio.pt), '-ssrc', String(stream.audioSsrc),
    '-f', 'rtp', '-srtp_out_suite', SRTP_SUITE, '-srtp_out_params', srtp(stream.audioKey),
    `srtp://${stream.address}:${stream.audioPort}?rtcpport=${stream.audioPort}&localrtcpport=${stream.audioRtcpPort ?? stream.localAudioPort}&pkt_size=188`,
  );
  return args;
}

export function snapshotArgs(width, height) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-f', 'h264', '-i', 'pipe:0', '-frames:v', '1',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
  ];
}

export class DoorbellCamera {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {import('homebridge').PlatformAccessory} options.accessory a new accessory (category camera)
   * @param {import('./session.js').DoorbellSession} options.session
   * @param {string} options.ffmpegPath
   * @param {object} options.camera ecobee's camera: name, serialNumber, firmwareVersion
   * @param {string} options.version plugin version, for the accessory information
   * @param {() => boolean} [options.cloudDown] the plugin can't reach ecobee (or is signed out)
   * @param {import('../ecobee.js').EcobeeCloud} [options.cloud] and `homeId`: motion from ecobee's events while there is no HAP link
   * @param {import('./hap-link.js').DoorbellHapLink} [options.link] the doorbell's HAP link: makes this a video
   *   doorbell with the ring and a motion sensor
   */
  constructor({ api, log, accessory, session, ffmpegPath, camera, version, cloudDown = () => false, link, cloud, homeId, capturePath, motionGrace = DEFAULT_GRACE, twoWayAudio = false, twoWayAudioTest = false }) {
    this.motionGrace = motionGrace;
    this.twoWayAudio = twoWayAudio === true;
    this.twoWayAudioTest = this.twoWayAudio && twoWayAudioTest === true;
    this.api = api;
    this.hap = api.hap;
    this.log = log;
    this.accessory = accessory;
    this.session = session;
    this.ffmpegPath = ffmpegPath;
    this.name = camera.name;
    this.cloudDown = cloudDown;
    this.pending = new Map();
    this.live = new Map();
    this.snapshot = undefined;
    this.snapshotJob = undefined;
    this.offline = false;
    this.stopped = false;
    this.cloud = cloud;
    this.homeId = homeId;
    this.cameraId = camera.id;
    this.motionSources = { link: link?.motion === true, linkUntil: 0, ringUntil: 0, pollUntil: 0, pollSince: 0 };
    this.motionInfo = { active: false, since: 0, lastActive: 0 };
    this.linkOffline = false;
    this.buffer = new MediaBuffer(session, { log, name: camera.name });
    this.recorder = new HksvRecorder({
      hap: this.hap, log, name: camera.name, ffmpegPath, buffer: this.buffer, motion: () => this.motionInfo, capturePath,
      requestKeyframe: () => session.requestKeyframe(true),
    });

    const { Service, Characteristic } = this.hap;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, camera.name)
      .setCharacteristic(Characteristic.Manufacturer, 'ecobee')
      .setCharacteristic(Characteristic.Model, 'Smart Doorbell Camera live view')
      .setCharacteristic(Characteristic.SerialNumber, `${camera.serialNumber ?? camera.id ?? 'camera'}-live`)
      .setCharacteristic(Characteristic.FirmwareRevision, version);

    const { VideoCodecType, H264Profile, H264Level, AudioStreamingCodecType, AudioStreamingSamplerate, SRTPCryptoSuites } = this.hap;
    const Controller = link ? this.hap.DoorbellController : this.hap.CameraController;
    this.controller = new Controller({
      cameraStreamCount: 2,
      ...(link ? { name: camera.name } : {}),
      sensors: { motion: true },
      recording: { options: recordingOptions(this.hap, RECORDING_RESOLUTIONS), delegate: this.recorder },
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: RESOLUTIONS,
          codec: {
            type: VideoCodecType.H264,
            profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
        },
        audio: {
          twoWayAudio: this.twoWayAudio,
          codecs: [
            { type: AudioStreamingCodecType.AAC_ELD, samplerate: AudioStreamingSamplerate.KHZ_16, audioChannel: 1 },
            { type: AudioStreamingCodecType.AAC_ELD, samplerate: AudioStreamingSamplerate.KHZ_24, audioChannel: 1 },
          ],
        },
      },
    });
    accessory.configureController(this.controller);
    this.recorder.controller = this.controller;
    this.link = link;
    this.setupMotion();
    if (link) {
      this.setupDoorbell(link);
    }
    this.watchCameraMode();

    // A new session to the camera starts its RTP numbering again, which a running live view's ffmpeg can't follow:
    // start its ffmpeg again (same HomeKit ports, keys and SSRCs).
    let hadLive = false;
    session.on('state', (state) => {
      if (state === 'disconnected') {
        hadLive ||= this.live.size > 0;
      } else if (state === 'connected' && hadLive) {
        hadLive = false;
        for (const { request } of [...this.live.values()]) {
          this.log.info(`"${this.name}" camera stream restarted; restarting the live view.`);
          this.startLive(request).catch(error => this.log.error(`"${this.name}" live view could not restart: ${error.message}`));
        }
      }
    });
    this.timer = setInterval(() => this.checkOnline(), CHECK_EVERY);
    this.motionTimer = setInterval(() => this.evaluateMotion(), 1000);
  }

  /** HomeKit's "camera off" (HomeKitCameraActive): HAP-NodeJS refuses live views and recordings itself; say so once. */
  watchCameraMode() {
    const { Characteristic } = this.hap;
    this.controller.recordingManagement?.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive)
      .on('change', ({ newValue }) => {
        this.log.info(`"${this.name}" was turned ${newValue ? 'on' : 'off'} in the Home app${newValue ? '.' : '; live view and recording are refused until it is on again.'}`);
      });
  }

  /**
   * The motion sensor HomeKit records on. Motion is the doorbell's own (the HAP link, within a second), or a doorbell
   * press (briefly), or, while there's no link, ecobee's cloud events.
   */
  setupMotion() {
    const { Characteristic, HapStatusError, HAPStatus } = this.hap;
    const service = this.controller.motionService;
    service.setCharacteristic(Characteristic.Name, `${this.name} Motion`);
    this.motionChar = service.getCharacteristic(Characteristic.MotionDetected);
    this.motionChar.onGet(() => {
      if (this.linkOffline) {
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return this.motionInfo.active;
    });
    if (this.link) {
      this.link.on('motion', (value) => {
        this.log.debug(`"${this.name}" doorbell sensor: motion ${value ? 'detected' : 'over'}.`);
        this.motionSources.link = value;
        if (value) {
          this.motionSources.linkUntil = Date.now() + this.motionGrace;
        }
        this.evaluateMotion();
      });
    }
  }

  evaluateMotion() {
    const now = Date.now();
    const sources = this.motionSources;
    if (sources.link) {
      sources.linkUntil = now + this.motionGrace;
    }
    // The longest of the holds wins.
    const until = Math.max(sources.linkUntil, sources.ringUntil, sources.pollUntil);
    const wanted = sources.link || now < until;
    const info = this.motionInfo;
    let active = wanted;
    if (wanted && !info.active) {
      // New motion. While a recording stream from the last motion is still open, wait for HomeKit to close it.
      const since = sources.link || now < sources.ringUntil || now < sources.linkUntil ? now : Math.min(now, sources.pollSince || now);
      this.held ??= { since, until: now + MOTION_GATE };
      if (this.recorder.hasOpenStream() && now < this.held.until) {
        active = false;
      } else {
        info.since = this.held.since;
        info.heldBack = this.held.since < now - 1500;
        if (now >= this.held.until) {
          this.log.debug(`"${this.name}" motion held back for ${MOTION_GATE / 1000} s while a recording was open; reporting it now.`);
        }
        this.held = undefined;
      }
    } else if (!wanted) {
      this.held = undefined;
    }
    if (active) {
      if (!info.active) {
        this.log.info(`"${this.name}" motion.`);
      }
      info.lastActive = now;
    } else if (info.active) {
      this.log.info(`"${this.name}" motion over.`);
      info.heldBack = false;
    }
    if (active !== info.active) {
      info.active = active;
      if (!this.linkOffline) {
        this.motionChar.updateValue(active);
      }
    }
  }

  /** Ring and motion from the doorbell's own HomeKit server; No Response while that link is down. */
  setupDoorbell(link) {
    const { Characteristic, HapStatusError, HAPStatus } = this.hap;
    const error = () => new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    // The ring itself can't show No Response: HAP-NodeJS always answers reads of a programmable switch
    // event with null (and updating it would look like a press).
    link.on('ring', (value) => {
      this.log.info(`"${this.name}" doorbell ${['pressed', 'pressed twice', 'pressed and held'][value] ?? 'pressed'}.`);
      this.controller.doorbellService.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, value);
      this.motionSources.ringUntil = Math.max(this.motionSources.ringUntil, Date.now() + this.motionGrace);
      this.evaluateMotion();
    });
    this.setupToggles(link);
    this.updateLinkOffline = (offline) => {
      if (offline === this.linkOffline) {
        return;
      }
      this.linkOffline = offline;
      this.motionChar.updateValue(offline ? error() : this.motionInfo.active);
    };
  }

  /**
   * The doorbell's own toggles, as the native integration showed them: Chime Doorbell (the doorbell's Mute),
   * Camera Status Light and Night Vision Light. The Home app sets them through the link; the doorbell's own changes
   * (and its values on every connect) come back through it. HomeKit services can't change after publishing, so all three
   * are added; one the doorbell turns out not to have fails when set.
   */
  setupToggles(link) {
    const { Characteristic, HapStatusError, HAPStatus } = this.hap;
    const mode = this.controller.recordingManagement?.operatingModeService;
    const toggles = {
      // The Home app's "Chime Doorbell" is the inverse of HAP's Mute (the Home app does that); Mute is passed on as it is.
      mute: { service: this.controller.doorbellService, characteristic: Characteristic.Mute, log: v => `Chime turned ${v ? 'off' : 'on'}` },
      indicator: { service: mode, characteristic: Characteristic.CameraOperatingModeIndicator, log: v => `Camera status light turned ${v ? 'on' : 'off'}` },
      nightVision: { service: mode, characteristic: Characteristic.NightVision, log: v => `Night vision light turned ${v ? 'on' : 'off'}` },
    };
    const current = {};
    for (const [name, toggle] of Object.entries(toggles)) {
      if (!toggle.service) {
        delete toggles[name];
        continue;
      }
      const characteristic = toggle.service.getCharacteristic(toggle.characteristic) ?? toggle.service.addCharacteristic(toggle.characteristic);
      toggle.char = characteristic;
      characteristic.onGet(() => {
        if (this.linkOffline || !link.up) {
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return current[name] ?? characteristic.value;
      });
      characteristic.onSet(async (value) => {
        try {
          await link.write(name, Boolean(value));
        } catch (error) {
          this.log.warn(`"${this.name}" ${toggle.log(value)} in the Home app, but the doorbell didn't take it: ${error.message}`);
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        current[name] = Boolean(value);
        this.log.info(`"${this.name}" ${toggle.log(value)}.`);
      });
    }
    link.on('setting', ({ name, value }) => {
      const toggle = toggles[name];
      if (!toggle) {
        return;
      }
      const home = Boolean(value);
      if (current[name] !== undefined && current[name] !== home) {
        this.log.info(`"${this.name}" ${toggle.log(value)} at the doorbell.`);
      }
      current[name] = home;
      toggle.char.updateValue(home);
    });
  }

  /** Without the HAP link (not paired, or down), ecobee's own events say when there is motion (a few seconds late). */
  async pollEvents() {
    if (this.stopped || !this.cloud || !this.homeId || this.link?.up) {
      return;
    }
    try {
      const events = await this.cloud.getCameraEvents(this.homeId, this.cameraId, 5);
      const now = Date.now();
      const fresh = events.map(e => Date.parse(e.startedAt)).filter(t => t && now - t < POLLED_MOTION);
      if (fresh.length) {
        const newest = Math.max(...fresh);
        if (newest + this.motionGrace > this.motionSources.pollUntil) {
          this.motionSources.pollSince ||= Math.min(...fresh);
          this.motionSources.pollUntil = newest + this.motionGrace;
        }
      }
      if (now >= this.motionSources.pollUntil) {
        this.motionSources.pollSince = 0;
      }
      this.evaluateMotion();
    } catch (error) {
      this.log.debug(`"${this.name}" could not read ecobee's events: ${error.message}`);
    }
  }

  /** Start the live view session (the accessory is published by the caller). */
  start() {
    this.session.start();
    if (this.cloud && this.homeId) {
      this.pollTimer = setInterval(() => this.pollEvents(), POLL_EVERY);
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.motionTimer);
    clearInterval(this.pollTimer);
    for (const id of [...this.live.keys()]) {
      this.endLive(id);
    }
    this.pending.clear();
    this.recorder.streams.forEach(stream => stream.stop());
    this.session.stop();
  }

  // ── No Response ──

  /**
   * The camera counts as offline once the session has been down for a minute, or while the plugin
   * can't reach ecobee. Its streaming characteristics then fail reads, which the Home app shows as
   * No Response; the first read that works puts them back.
   */
  checkOnline() {
    this.updateLinkOffline?.(this.link.paired && this.link.downFor() > OFFLINE_AFTER);
    const offline = this.cloudDown() || this.session.downFor() > OFFLINE_AFTER;
    if (offline === this.offline) {
      return;
    }
    this.offline = offline;
    const { Characteristic } = this.hap;
    const error = new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    for (const management of this.controller.streamManagements ?? []) {
      const service = management.getService();
      for (const characteristic of [Characteristic.Active, Characteristic.StreamingStatus]) {
        const c = service.getCharacteristic(characteristic);
        c.updateValue(offline ? error : c.value);
      }
    }
    this.log[offline ? 'warn' : 'info'](offline
      ? `"${this.name}" is offline; the Home app shows No Response until the live view session is back.`
      : `"${this.name}" is back online.`);
  }

  // ── Snapshots ──

  handleSnapshotRequest(request, callback) {
    this.snapshotFor(request.width, request.height).then(
      jpeg => callback(undefined, jpeg),
      error => callback(error),
    );
  }

  async snapshotFor(width, height) {
    const keyframe = this.session.latestKeyframe;
    if (!this.session.connected || !keyframe) {
      throw new Error('no picture from the camera yet');
    }
    const key = `${width}x${height}`;
    if (this.snapshot?.key === key && Date.now() - this.snapshot.at < SNAPSHOT_CACHE) {
      return this.snapshot.jpeg;
    }
    if (this.snapshotJob?.key === key) {
      return this.snapshotJob.promise;
    }
    const promise = this.decode(keyframe.data, width, height).then((jpeg) => {
      this.snapshot = { key, at: Date.now(), jpeg };
      return jpeg;
    }).finally(() => {
      this.snapshotJob = undefined;
    });
    this.snapshotJob = { key, promise };
    return promise;
  }

  decode(data, width, height) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpegPath, snapshotArgs(width, height), { stdio: ['pipe', 'pipe', 'pipe'] });
      const out = [];
      let err = '';
      const timeout = setTimeout(() => child.kill('SIGKILL'), SNAPSHOT_TIMEOUT);
      child.stdout.on('data', chunk => out.push(chunk));
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.stdin.on('error', () => {});
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        const jpeg = Buffer.concat(out);
        if (code === 0 && jpeg.length) {
          resolve(jpeg);
        } else {
          reject(new Error(`ffmpeg could not make a snapshot (${code}) ${err.trim().split('\n').pop() ?? ''}`.trim()));
        }
      });
      child.stdin.end(data);
    });
  }

  // ── Live view ──

  async prepareStream(request, callback) {
    try {
      const [localVideoPort, localAudioPort] = await allocatePorts(2);
      const { CameraController } = this.hap;
      const address = request.sourceAddress.startsWith('::ffff:') ? request.sourceAddress.slice(7) : request.sourceAddress;
      this.pending.set(request.sessionID, {
        address: request.targetAddress,
        videoPort: request.video.port,
        audioPort: request.audio.port,
        videoKey: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        audioKey: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
        videoSsrc: CameraController.generateSynchronisationSource(),
        audioSsrc: CameraController.generateSynchronisationSource(),
        // Where ffmpeg sends from (HomeKit's RTCP comes back to these) ...
        localVideoPort,
        localAudioPort,
      });
      const stream = this.pending.get(request.sessionID);
      callback(undefined, {
        address,
        video: { port: localVideoPort, ssrc: stream.videoSsrc, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
        audio: { port: localAudioPort, ssrc: stream.audioSsrc, srtp_key: request.audio.srtp_key, srtp_salt: request.audio.srtp_salt },
      });
    } catch (error) {
      callback(error);
    }
  }

  async handleStreamRequest(request, callback) {
    const { StreamRequestTypes } = this.hap;
    try {
      if (request.type === StreamRequestTypes.START) {
        await this.startLive(request);
      } else if (request.type === StreamRequestTypes.STOP) {
        this.endLive(request.sessionID);
        this.pending.delete(request.sessionID);
      }
      // RECONFIGURE: the picture is copied, so there is nothing to change.
      callback();
    } catch (error) {
      this.log.error(`"${this.name}" live view could not start: ${error.message}`);
      this.endLive(request.sessionID);
      this.pending.delete(request.sessionID);
      callback(error);
    }
  }

  async startLive(request) {
    const stream = this.pending.get(request.sessionID);
    if (!stream) {
      throw new Error('unknown stream session');
    }
    if (!this.session.connected) {
      throw new Error('the camera is not connected');
    }
    this.endLive(request.sessionID);
    const [videoPort, audioPort] = await allocatePorts(2);
    // Two-way talk: this plugin owns the audio port HomeKit sends to (its RTCP and the microphone), and ffmpeg's RTCP uses another.
    let talk;
    let liveStream = stream;
    if (this.twoWayAudio && this.session.talkReady && request.audio.codec === this.hap.AudioStreamingCodecType.AAC_ELD) {
      try {
        const [rtcpPort, rtpPort] = await allocatePorts(2);
        talk = new ReturnAudio({
          ffmpegPath: this.ffmpegPath,
          localPort: stream.localAudioPort,
          rtcpPort,
          rtpPort,
          audio: request.audio,
          key: stream.audioKey,
          send: packet => this.session.sendTalk(packet),
          log: this.log,
          name: this.name,
        });
        await talk.start();
        liveStream = { ...stream, audioRtcpPort: rtcpPort };
      } catch (error) {
        talk = undefined;
        this.log.warn(`"${this.name}" talk: not available in this live view (${error.message}).`);
      }
    }
    const args = liveArgs({ hap: this.hap, request, stream: liveStream });
    this.log.debug(`"${this.name}" live view: ffmpeg ${args.join(' ').replace(/-srtp_out_params \S+/g, '-srtp_out_params …')}`);
    const child = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const live = { request, child, removeSink: undefined, timers: [], stopping: false, stderr: [], startedAt: Date.now(), counters: { ...this.session.counters }, talk };
    this.live.set(request.sessionID, live);
    child.stdin.on('error', () => {});
    child.stdin.end(buildSdp({ videoPort, audioPort, sprop: this.session.sprop }));
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const text = line.trim();
        if (!text) {
          continue;
        }
        live.stderr = [...live.stderr.slice(-9), text];
        // ffmpeg's decoders complain while probing the copied stream; that isn't a failure.
        this.log[DECODER_LINE.test(text) ? 'debug' : 'error'](`"${this.name}" ffmpeg: ${text}`);
      }
    });
    child.on('error', (error) => {
      this.log.error(`"${this.name}" could not run ffmpeg: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (live.stopping) {
        return;
      }
      this.log.error(`"${this.name}" live view: ffmpeg stopped (${signal ?? code}).`);
      this.endLive(request.sessionID);
      this.controller.forceStopStreamingSession(request.sessionID);
    });
    live.removeSink = this.session.addSink({ videoPort, audioPort });
    // The first keyframe asked for after ffmpeg is listening, then once more in case that one was lost.
    live.timers.push(setTimeout(() => this.session.requestKeyframe(true), 600));
    this.log.info(`"${this.name}" live view started${talk ? ' (talk is on)' : ''}.`);
    if (this.twoWayAudioTest && this.session.talkReady && this.toneSession !== request.sessionID) {
      this.toneSession = request.sessionID;
      live.timers.push(setTimeout(() => this.testTone(), 1000));
    }
  }

  /** Two-way talk test: a 3-second tone on the doorbell's speaker, for someone at the door to hear. */
  async testTone() {
    try {
      this.log.info(`"${this.name}" test tone: playing for 3 s; listen at the doorbell.`);
      const { sent, refused } = await playTestTone({
        ffmpegPath: this.ffmpegPath, send: packet => this.session.sendTalk(packet), log: this.log, name: this.name,
      });
      this.log.info(`"${this.name}" test tone sent (${sent} packets${refused ? `, ${refused} not taken by the session` : ''}).`);
    } catch (error) {
      this.log.warn(`"${this.name}" test tone failed: ${error.message}`);
    }
  }

  endLive(sessionID) {
    const live = this.live.get(sessionID);
    if (!live) {
      return;
    }
    this.live.delete(sessionID);
    live.stopping = true;
    live.timers.forEach(clearTimeout);
    live.removeSink?.();
    live.child.kill('SIGKILL');
    if (live.talk) {
      live.talk.stop();
      this.log.info(`"${this.name}" talk: ${live.talk.sent} packets sent to the doorbell`
        + `${live.talk.refused ? ` (${live.talk.refused} refused)` : ''}; ${live.talk.micPackets} microphone packets from the Home app.`);
    }
    if (!this.stopped) {
      const now = this.session.counters;
      const was = live.counters;
      const diff = key => now[key] - was[key];
      const gaps = diff('audioGaps');
      this.log.info(`"${this.name}" live view ended after ${Math.round((Date.now() - live.startedAt) / 1000)} s `
        + `(video: ${diff('videoSkipped')} skipped of ${diff('videoPackets')} packets; `
        + `audio: ${diff('audioSkipped')} skipped of ${diff('audioPackets')}`
        + `${gaps ? `, ${gaps} gaps from the camera` : ''}).`);
    }
  }
}
