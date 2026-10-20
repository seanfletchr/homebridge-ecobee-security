import { EventEmitter } from 'node:events';

import { Depacketizer, parseRtp } from './h264.js';

// A ring buffer of the camera's last seconds: H.264 access units and Opus packets, each with a wall-clock
// time (ms) worked out from its RTP timestamp. Recordings start from a keyframe a few seconds back and
// then follow the live edge.

const RETAIN = 30 * 1000;
// If the stream's own clock and the arrival time drift this far apart, start counting again from now.
const REANCHOR_AFTER = 2000;
const START_CODE_LENGTH = 4;

/** Maps one track's RTP timestamps (32-bit, wrapping) to wall-clock ms. */
class Clock {
  constructor(rate) {
    this.rate = rate;
    this.reset();
  }

  reset() {
    this.anchor = undefined;
  }

  /** @returns {number} ms; never earlier than the previous call */
  time(timestamp, ssrc, now = Date.now()) {
    if (!this.anchor || this.anchor.ssrc !== ssrc) {
      this.anchor = { ssrc, ts: timestamp, wall: now, last: timestamp, elapsed: 0 };
      this.lastTime = now;
      return now;
    }
    // Unwrap the 32-bit timestamp: step from the previous packet, signed.
    const step = ((timestamp - this.anchor.last) << 0);
    this.anchor.elapsed += step;
    this.anchor.last = timestamp;
    let time = this.anchor.wall + (this.anchor.elapsed / this.rate) * 1000;
    if (Math.abs(time - now) > REANCHOR_AFTER) {
      this.anchor = { ssrc, ts: timestamp, wall: now, last: timestamp, elapsed: 0 };
      time = now;
    }
    time = Math.max(time, (this.lastTime ?? 0) + 1);
    this.lastTime = time;
    return time;
  }
}

export class MediaBuffer extends EventEmitter {
  /** @param {import('./session.js').DoorbellSession} session */
  constructor(session, { log, name } = {}) {
    super();
    this.log = log;
    this.name = name;
    this.video = [];
    this.audio = [];
    this.videoBase = 0;
    this.audioBase = 0;
    this.sps = undefined;
    this.pps = undefined;
    this.videoClock = new Clock(90000);
    this.audioClock = new Clock(48000);
    this.opusChannels = undefined;
    this.pendingSsrc = undefined;
    this.depacketizer = new Depacketizer(
      (nals) => this.onFrame(nals),
      () => {},
    );
    session.on('rtp', ({ kind, packet }) => this.push(kind, packet));
    session.on('state', (state) => {
      if (state === 'connected') {
        this.reanchor();
      }
    });
  }

  /** Count time again from the next packets (a new session, so the old RTP clock means nothing). */
  reanchor() {
    if (this.video.length) {
      this.log?.info(`"${this.name}" camera stream restarted; recordings carry on with a new time base (times stay in order).`);
    }
    this.videoClock.reset();
    this.audioClock.reset();
    this.depacketizer = new Depacketizer((nals) => this.onFrame(nals), () => {});
  }

  push(kind, raw) {
    const packet = parseRtp(raw);
    if (!packet) {
      return;
    }
    if (kind === 'video') {
      this.currentTimestamp = packet.header.timestamp;
      this.currentSsrc = packet.header.ssrc;
      this.depacketizer.push(packet);
    } else if (packet.payload.length) {
      const time = this.audioClock.time(packet.header.timestamp, packet.header.ssrc);
      this.opusChannels ??= packet.payload[0] & 0x04 ? 2 : 1;
      this.audio.push({ seq: this.audioBase + this.audio.length, time, data: Buffer.from(packet.payload) });
      this.trim();
      this.emit('data');
    }
  }

  onFrame(nals) {
    const time = this.videoClock.time(this.currentTimestamp, this.currentSsrc);
    const units = [];
    let key = false;
    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === 7) {
        this.sps = Buffer.from(nal);
      } else if (type === 8) {
        this.pps = Buffer.from(nal);
      } else if (type === 5 || type === 1 || type === 2 || type === 3 || type === 4 || type === 6) {
        key ||= type === 5;
        const length = Buffer.alloc(START_CODE_LENGTH);
        length.writeUInt32BE(nal.length);
        units.push(length, nal);
      }
    }
    if (!units.length) {
      return;
    }
    // Concat copies, so a frame doesn't keep the datagram buffers it came from alive.
    this.video.push({ seq: this.videoBase + this.video.length, time, key, data: Buffer.concat(units) });
    this.trim();
    this.emit('data');
  }

  /** Drop what is older than the retention time, always starting the video again at a keyframe. */
  trim() {
    const newest = Math.max(this.video.at(-1)?.time ?? 0, this.audio.at(-1)?.time ?? 0);
    const cutoff = newest - RETAIN;
    let v = 0;
    while (v < this.video.length && this.video[v].time < cutoff) {
      v++;
    }
    // Leave the video at a keyframe: skip forward to the next one if we stopped mid-GOP.
    while (v < this.video.length && v > 0 && !this.video[v].key) {
      v++;
    }
    if (v >= this.video.length) {
      v = Math.max(0, this.video.length - 1);
    }
    if (v > 0) {
      this.video.splice(0, v);
      this.videoBase += v;
    }
    let a = 0;
    while (a < this.audio.length && this.audio[a].time < cutoff) {
      a++;
    }
    if (a > 0) {
      this.audio.splice(0, a);
      this.audioBase += a;
    }
  }

  /** Is there anything to start a recording from? */
  get ready() {
    return Boolean(this.sps && this.pps && this.video.some(f => f.key));
  }

  /** Seconds of video held. */
  get length() {
    return this.video.length ? (this.video.at(-1).time - this.video[0].time) / 1000 : 0;
  }

  /**
   * A reader that starts at the keyframe at or before `time` and from there follows the live edge.
   * If that keyframe is more than `maxBack` ms before `now` (the camera stretched its keyframe
   * interval) or there is none, it starts at the first keyframe after `time` instead, or at the newest
   * one. `read()` returns what has come in since, in time order: [{kind, time, data, key}].
   */
  cursor(time, { now = Date.now(), maxBack = 8000 } = {}) {
    let index = -1;
    for (let i = 0; i < this.video.length; i++) {
      if (this.video[i].key && this.video[i].time <= time) {
        index = i;
      }
    }
    if (index < 0 || now - this.video[index].time > maxBack) {
      const after = this.video.findIndex(f => f.key && f.time > time && f.time <= now);
      if (after >= 0) {
        index = after;
      } else if (index < 0) {
        let newest = -1;
        for (let i = 0; i < this.video.length; i++) {
          if (this.video[i].key && this.video[i].time <= now) {
            newest = i;
          }
        }
        index = newest >= 0 ? newest : Math.max(0, this.video.findIndex(f => f.key));
      }
    }
    const first = this.video[index];
    const audioIndex = this.audio.findIndex(p => p.time >= (first?.time ?? 0));
    return {
      start: first?.time ?? time,
      nextVideo: this.videoBase + index,
      nextAudio: this.audioBase + (audioIndex < 0 ? this.audio.length : audioIndex),
      includeAudio: true,
    };
  }

  read(cursor) {
    const out = [];
    const vi = Math.max(cursor.nextVideo - this.videoBase, 0);
    for (const f of this.video.slice(vi)) {
      out.push({ kind: 'video', time: f.time, data: f.data, key: f.key });
    }
    cursor.nextVideo = this.videoBase + this.video.length;
    if (cursor.includeAudio) {
      const ai = Math.max(cursor.nextAudio - this.audioBase, 0);
      for (const p of this.audio.slice(ai)) {
        out.push({ kind: 'audio', time: p.time, data: p.data, key: true });
      }
    }
    cursor.nextAudio = this.audioBase + this.audio.length;
    // Stable by time; video first when equal.
    return out.sort((x, y) => x.time - y.time);
  }
}
