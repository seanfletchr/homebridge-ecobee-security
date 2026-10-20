import { spawn } from 'node:child_process';

import { MkvWriter, AUDIO_TRACK, VIDEO_TRACK } from './mkv.js';
import { RecordingCapture, fragmentInfo, initTracks } from './mp4info.js';

// HomeKit Secure Video recording: the buffered video from just before the motion, then the live video,
// as fragmented MP4 from ffmpeg (video copied, Opus turned into AAC-LC), until HomeKit closes the stream
// or the motion is over.

const MAX_RECORDING = 5 * 60 * 1000;
const WAIT_FOR_BUFFER = 6 * 1000;
// The newest the start of a clip may be placed before the request, and the longest fragment HomeKit should be sent.
const MAX_PREROLL = 5 * 1000;
// ... or this much if the motion was held back until the previous clip's stream closed.
const MAX_PREROLL_HELD = 12 * 1000;
const MAX_FRAGMENT = 8;
// HomeKit's profile and level numbers (hap-nodejs H264Profile / H264Level) as libx264 wants them.
// Never Baseline (0): HomeKit only offers Main and High for recordings, and a Baseline stream never showed up in the Home app.
const PROFILE_NAME = { 1: 'main', 2: 'high' };
const LEVEL_NAME = { 0: '3.1', 1: '3.2', 2: '4.0' };
const SAMPLE_RATES = { 0: 8000, 1: 16000, 2: 24000, 3: 32000, 4: 44100, 5: 48000 };

/** Recording options for the HAP camera controller. */
export function recordingOptions(hap, resolutions) {
  return {
    prebufferLength: 4000,
    mediaContainerConfiguration: [{ type: hap.MediaContainerType.FRAGMENTED_MP4, fragmentLength: 4000 }],
    video: {
      type: hap.VideoCodecType.H264,
      parameters: {
        profiles: [hap.H264Profile.MAIN, hap.H264Profile.HIGH],
        levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
      },
      resolutions,
    },
    audio: {
      codecs: [{
        type: hap.AudioRecordingCodecType.AAC_LC,
        audioChannels: 1,
        samplerate: [hap.AudioRecordingSamplerate.KHZ_16, hap.AudioRecordingSamplerate.KHZ_24],
      }],
    },
  };
}

/** Cuts ffmpeg's fragmented MP4 into the init segment (ftyp + moov) and then moof + mdat pairs. */
export class Mp4Splitter {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.group = [];
    this.initSent = false;
  }

  /** @returns {Buffer[]} complete segments, in order */
  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.pending.length < 8) {
        break;
      }
      let size = this.pending.readUInt32BE(0);
      if (size === 1) {
        if (this.pending.length < 16) {
          break;
        }
        size = Number(this.pending.readBigUInt64BE(8));
      }
      if (size < 8 || this.pending.length < size) {
        break;
      }
      const type = this.pending.toString('latin1', 4, 8);
      const box = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      this.group.push(box);
      if (!this.initSent && type === 'moov') {
        this.initSent = true;
        out.push(Buffer.concat(this.group));
        this.group = [];
      } else if (this.initSent && type === 'mdat') {
        out.push(Buffer.concat(this.group));
        this.group = [];
      }
    }
    if (this.pending.length) {
      this.pending = Buffer.from(this.pending);
    }
    return out;
  }
}

export class HksvRecorder {
  /**
   * @param {object} options
   * @param {object} options.hap
   * @param {import('homebridge').Logging} options.log
   * @param {string} options.name
   * @param {string} options.ffmpegPath
   * @param {import('./buffer.js').MediaBuffer} options.buffer
   * @param {() => {active: boolean, since: number, lastActive: number}} options.motion the motion state
   */
  constructor({ hap, log, name, ffmpegPath, buffer, motion, capturePath, requestKeyframe }) {
    this.requestKeyframe = requestKeyframe;
    this.capturePath = capturePath;
    this.hap = hap;
    this.log = log;
    this.name = name;
    this.ffmpegPath = ffmpegPath;
    this.buffer = buffer;
    this.motion = motion;
    this.controller = undefined;
    this.config = undefined;
    this.active = false;
    this.streams = new Map();
    this.log.info(`"${this.name}" HomeKit Secure Video recordings are encoded in software (libx264).`);
  }

  /**
   * ffmpeg arguments for recordings. Software encoding (libx264) only: the Raspberry Pi's hardware encoder
   * (h264_v4l2m2m) output never became a clip in HomeKit. These are the arguments homebridge-nest-accfactory uses for
   * HomeKit Secure Video (preset ultrafast instead of its veryfast, which is too slow on a Raspberry Pi 4 at this size).
   */
  videoArgs(config, skip, withAudio) {
    const [width, height, fps] = config.videoCodec.resolution;
    const parameters = config.videoCodec.parameters;
    const gop = Math.max(1, Math.round((fps * (parameters.iFrameInterval || 4000)) / 1000));
    const kbps = Math.max(100, Number(parameters.bitRate) || 2000);
    const filter = [...(skip > 0.04 ? [`trim=start=${skip.toFixed(3)}`, 'setpts=PTS-STARTPTS'] : []),
      `fps=fps=${fps}`, `scale=${width}:${height}`, 'format=yuv420p'].join(',');
    return [
      '-map', '0:v:0',
      '-codec:v', 'libx264', '-preset', 'ultrafast', '-x264-params', 'cabac=1', '-bf', '0',
      '-profile:v', PROFILE_NAME[parameters.profile] ?? 'main', '-level:v', LEVEL_NAME[parameters.level] ?? '4.0',
      '-filter:v', filter, '-fps_mode', 'cfr', '-g:v', String(gop),
      '-b:v', `${Math.round(kbps * 2)}k`, '-maxrate', `${Math.round(kbps * 2)}k`, '-bufsize', `${Math.round(kbps * 4)}k`,
      '-video_track_timescale', '90000',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      ...(withAudio ? ['-map', '0:a:0', '-codec:a', 'libfdk_aac', '-profile:a', 'aac_low', '-ar', '16000', '-b:a', '16k', '-ac', '1',
        '-filter:a', `${skip > 0.04 ? `atrim=start=${skip.toFixed(3)},asetpts=PTS-STARTPTS,` : ''}aresample=async=1:first_pts=0`] : []),
    ];
  }

  updateRecordingActive(active) {
    if (active !== this.active) {
      this.log.info(`"${this.name}" HomeKit Secure Video recording turned ${active ? 'on' : 'off'}.`);
    }
    this.active = active;
  }

  updateRecordingConfiguration(config) {
    this.config = config;
    if (config) {
      try {
        const text = JSON.stringify({ videoCodec: config.videoCodec, audioCodec: config.audioCodec,
          mediaContainerConfiguration: config.mediaContainerConfiguration, prebufferLength: config.prebufferLength });
        if (text !== this.lastConfigText) {
          this.lastConfigText = text;
          this.log.info(`"${this.name}" HomeKit's selected recording configuration: ${text}`);
        }
      } catch {
        // only a diagnostic
      }
      const [w, h, fps] = config.videoCodec.resolution;
      this.log.debug(`"${this.name}" recording configuration: ${w}x${h}@${fps}, prebuffer ${config.prebufferLength} ms, `
        + `audio ${SAMPLE_RATES[config.audioCodec.samplerate] ?? '?'} Hz ${config.audioCodec.bitrate} kb/s`);
    }
  }

  closeRecordingStream(streamId, reason) {
    const name = reason === undefined ? 'connection closed' : (this.hap.HDSProtocolSpecificErrorReason?.[reason] ?? String(reason));
    this.log.debug(`"${this.name}" recording stream ${streamId} closed by HomeKit (${name}).`);
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.closed = true;
      stream.reason = name;
      stream.stop();
    }
  }

  acknowledgeStream() {}

  /** Is a recording stream open that HomeKit hasn't closed? */
  hasOpenStream() {
    return [...this.streams.values()].some(stream => !stream.closed);
  }

  /** Is the audio track wanted? HomeKit's "Record audio" switch. */
  audioWanted() {
    const service = this.controller?.recordingManagement?.recordingManagementService;
    return service ? Boolean(service.getCharacteristic(this.hap.Characteristic.RecordingAudioActive).value) : true;
  }

  async *handleRecordingStreamRequest(streamId, signal) {
    const config = this.config;
    if (!config) {
      throw new Error('no recording configuration');
    }
    const motion = this.motion();
    const prebuffer = config.prebufferLength ?? 4000;
    const startedWhen = Date.now();
    // From shortly before the motion started, but not more than a few seconds before HomeKit asked
    // (a motion that has been held for a long time says nothing about the camera's last seconds).
    const from = Math.max((motion.active || startedWhen - motion.lastActive < 60000 ? Math.min(motion.since, startedWhen) : startedWhen) - prebuffer,
      startedWhen - (motion.heldBack ? MAX_PREROLL_HELD : MAX_PREROLL));
    const deadline = startedWhen + WAIT_FOR_BUFFER;
    while (!this.buffer.ready && Date.now() < deadline && !signal?.aborted) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!this.buffer.ready) {
      throw new Error('the camera has no picture to record');
    }

    // The video is re-encoded, so start decoding at whatever keyframe precedes `from` and cut the excess off.
    this.requestKeyframe?.();
    // Decoding the stretch before `from` is what delays the first output, so a keyframe that is much earlier than the
    // pre-roll asked for (a long keyframe gap) isn't used: the next one after `from` is.
    const cursor = this.buffer.cursor(from, { now: Date.now(), maxBack: MAX_PREROLL_HELD + 4000 });
    const skip = Math.max(0, (from - cursor.start) / 1000);
    const withAudio = this.audioWanted() && this.buffer.audio.length > 0;
    cursor.includeAudio = withAudio;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostats',
      '-fflags', '+discardcorrupt+genpts', '-avoid_negative_ts', 'make_zero', '-max_delay', '500000', '-flags', 'low_delay',
      '-analyzeduration', '1000000', '-probesize', '500000',
      '-f', 'matroska', '-i', 'pipe:0',
      ...this.videoArgs(config, skip, withAudio),
      '-f', 'mp4', 'pipe:1',
    ];
    this.log.debug(`"${this.name}" recording: ffmpeg ${args.join(' ')}`);
    const child = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { stalls: [], initAt: 0, fragmentAt: 0, fragments: 0, bytes: 0, queue: [], wake: undefined, ended: false, stopped: false, error: undefined };
    const wake = () => {
      state.wake?.();
      state.wake = undefined;
    };
    const stop = () => {
      if (state.stopped) {
        return;
      }
      state.stopped = true;
      this.buffer.off('data', onData);
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      wake();
    };
    const entry = { stop, reason: undefined };
    this.streams.set(streamId, entry);
    signal?.addEventListener('abort', stop, { once: true });

    const capture = this.capturePath ? new RecordingCapture(this.capturePath, this.log) : undefined;
    let tracks = [];
    const check = (segment, index) => {
      try {
        if (index === 0) {
          tracks = initTracks(segment);
          return;
        }
        const video = fragmentInfo(segment, tracks).find(t => t.type === 'vide');
        if (video && video.durationSeconds > MAX_FRAGMENT) {
          this.log.warn(`"${this.name}" recording: a fragment holds ${video.durationSeconds} s of video (${video.samples} frames); the camera went a long time without a keyframe.`);
        }
      } catch {
        // only a diagnostic
      }
    };
    const splitter = new Mp4Splitter();
    let seen = 0;
    child.stdout.on('data', (chunk) => {
      for (const segment of splitter.push(chunk)) {
        seen++;
        state.queue.push(segment);
        if (seen === 1) {
          state.initAt = Date.now();
        } else {
          state.fragmentAt ||= Date.now();
        }
      }
      wake();
    });
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) {
          this.log.debug(`"${this.name}" recording ffmpeg: ${line.trim()}`);
          state.error = line.trim();
        }
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      state.error = error.message;
      state.ended = true;
      wake();
    });
    child.on('close', () => {
      state.ended = true;
      wake();
    });

    const onData = () => wake();
    this.buffer.on('data', onData);
    const writer = new MkvWriter({
      sps: this.buffer.sps, pps: this.buffer.pps, start: cursor.start, opusChannels: withAudio ? this.buffer.opusChannels ?? 1 : 0,
    });
    const startedAt = Date.now();
    const [rw, rh, rfps] = config.videoCodec.resolution;
    this.log.info(`"${this.name}" recording started (${((Date.now() - from) / 1000).toFixed(1)} s before now, ${withAudio ? 'with' : 'without'} audio; `
      + `video re-encoded as ${rw}x${rh}@${rfps}, ${config.videoCodec.parameters.bitRate} kb/s, keyframe every `
      + `${((config.videoCodec.parameters.iFrameInterval || 4000) / 1000).toFixed(0)} s, libx264 software encoder (ultrafast)).`);

    // Feed ffmpeg what the buffer has, then follow it, until it's time to stop.
    const pump = (async () => {
      let first = true;
      let lastVideo = Date.now();
      let stalledSince;
      try {
        while (!state.stopped && !state.ended) {
          const items = this.buffer.read(cursor);
          // No video coming in (the camera's stream is struggling): the fragments HomeKit gets then come late; say so.
          const now = Date.now();
          if (items.some(item => item.kind === 'video')) {
            if (stalledSince !== undefined) {
              const seconds = (now - stalledSince) / 1000;
              state.stalls.push(seconds);
              this.log.info(`"${this.name}" recording: no video from the camera for ${seconds.toFixed(1)} s.`);
              stalledSince = undefined;
            }
            lastVideo = now;
          } else if (stalledSince === undefined && now - lastVideo > 1000) {
            stalledSince = lastVideo;
          }
          if (first || items.length) {
            const parts = first ? [writer.header()] : [];
            first = false;
            for (const item of items) {
              parts.push(writer.block(item.kind === 'video' ? VIDEO_TRACK : AUDIO_TRACK, item.time, item.data, item.key));
            }
            if (!child.stdin.write(Buffer.concat(parts))) {
              await new Promise(resolve => child.stdin.once('drain', resolve));
            }
          }
          // HomeKit decides when a clip is long enough (it closes the stream); this only guards against it never doing so.
          if (Date.now() - startedAt > MAX_RECORDING) {
            break;
          }
          if (!items.length) {
            await new Promise((resolve) => {
              state.wake = resolve;
              setTimeout(resolve, 500);
            });
          }
        }
      } catch {
        // ffmpeg went away; the reader below reports it
      } finally {
        stop();
      }
    })();

    try {
      for (;;) {
        if (signal?.aborted) {
          return;
        }
        while (state.queue.length) {
          const segment = state.queue.shift();
          // As homebridge-nest-accfactory does: every segment goes out as it comes, never marked last.
          state.fragments++;
          state.bytes += segment.length;
          check(segment, state.fragments - 1);
          capture?.add(segment);
          yield { data: segment, isLast: false };
        }
        if (state.ended) {
          break;
        }
        await new Promise((resolve) => {
          state.wake = resolve;
          setTimeout(resolve, 1000);
        });
      }
      if (!signal?.aborted && !state.fragments) {
        throw new Error(state.error ?? 'ffmpeg made no recording');
      }
    } finally {
      stop();
      child.kill('SIGKILL');
      await pump.catch(() => {});
      this.streams.delete(streamId);
      capture?.finish({ closedBy: signal?.aborted ? entry.reason ?? 'HomeKit' : undefined, audio: withAudio, from: new Date(from).toISOString() });
      this.log.info(`"${this.name}" recording ended after ${Math.round((Date.now() - startedAt) / 1000)} s `
        + `(${state.fragments} fragments, ${(state.bytes / 1024).toFixed(0)} KiB, init after ${state.initAt ? ((state.initAt - startedAt) / 1000).toFixed(1) : '?'} s, first fragment after ${state.fragmentAt ? ((state.fragmentAt - startedAt) / 1000).toFixed(1) : '?'} s${state.stalls.length ? `, ${state.stalls.length} input stalls (${state.stalls.map(x => x.toFixed(1)).join(', ')} s)` : ''}${signal?.aborted ? `, closed by HomeKit${entry.reason ? ` (${entry.reason})` : ''}` : ''}).`);
    }
  }
}
