import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';

// Debug aid for recordings: keeps what was sent to HomeKit, plus what the fragments say about their timing.

const KEEP = 5;

/** The child boxes of a box payload: [{type, start, end, payloadStart}] */
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    let head = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(o + 8));
      head = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < head || o + size > end) {
      break;
    }
    out.push({ type: buf.toString('latin1', o + 4, o + 8), start: o, end: o + size, payload: o + head });
    o += size;
  }
  return out;
}

const find = (buf, parent, type) => boxes(buf, parent.payload, parent.end).filter(b => b.type === type);

/** Tracks of an init segment (ftyp + moov): [{id, type: 'vide' | 'soun', timescale}] */
export function initTracks(buf) {
  const tracks = [];
  const moov = boxes(buf).find(b => b.type === 'moov');
  for (const trak of moov ? find(buf, moov, 'trak') : []) {
    const tkhd = find(buf, trak, 'tkhd')[0];
    const mdia = find(buf, trak, 'mdia')[0];
    const hdlr = mdia && find(buf, mdia, 'hdlr')[0];
    const mdhd = mdia && find(buf, mdia, 'mdhd')[0];
    if (!tkhd || !hdlr || !mdhd) {
      continue;
    }
    const idAt = buf[tkhd.payload] === 1 ? tkhd.payload + 20 : tkhd.payload + 12;
    const tsAt = buf[mdhd.payload] === 1 ? mdhd.payload + 20 : mdhd.payload + 12;
    tracks.push({ id: buf.readUInt32BE(idAt), type: buf.toString('latin1', hdlr.payload + 8, hdlr.payload + 12), timescale: buf.readUInt32BE(tsAt) });
  }
  return tracks;
}

/** Timing of one moof + mdat: per track base decode time (tfdt), sample count, total duration, first sample a sync sample. */
export function fragmentInfo(buf, tracks) {
  const moof = boxes(buf).find(b => b.type === 'moof');
  const out = [];
  for (const traf of moof ? find(buf, moof, 'traf') : []) {
    const tfhd = find(buf, traf, 'tfhd')[0];
    const tfdt = find(buf, traf, 'tfdt')[0];
    const trun = find(buf, traf, 'trun')[0];
    if (!tfhd) {
      continue;
    }
    const tfFlags = buf.readUIntBE(tfhd.payload + 1, 3);
    const id = buf.readUInt32BE(tfhd.payload + 4);
    let p = tfhd.payload + 8;
    if (tfFlags & 1) {
      p += 8;
    }
    if (tfFlags & 2) {
      p += 4;
    }
    const defaultDuration = tfFlags & 8 ? buf.readUInt32BE(p) : 0;
    if (tfFlags & 8) {
      p += 4;
    }
    if (tfFlags & 0x10) {
      p += 4;
    }
    const defaultFlags = tfFlags & 0x20 ? buf.readUInt32BE(p) : undefined;
    const track = tracks.find(t => t.id === id);
    const scale = track?.timescale || 1;
    const decode = tfdt ? (buf[tfdt.payload] === 1 ? Number(buf.readBigUInt64BE(tfdt.payload + 4)) : buf.readUInt32BE(tfdt.payload + 4)) : undefined;
    let samples = 0;
    let duration = 0;
    let firstKey;
    if (trun) {
      const flags = buf.readUIntBE(trun.payload + 1, 3);
      samples = buf.readUInt32BE(trun.payload + 4);
      let q = trun.payload + 8;
      if (flags & 1) {
        q += 4;
      }
      const firstFlags = flags & 4 ? buf.readUInt32BE(q) : undefined;
      if (flags & 4) {
        q += 4;
      }
      for (let i = 0; i < samples; i++) {
        let d = defaultDuration;
        if (flags & 0x100) {
          d = buf.readUInt32BE(q);
          q += 4;
        }
        if (flags & 0x200) {
          q += 4;
        }
        let f = defaultFlags;
        if (flags & 0x400) {
          f = buf.readUInt32BE(q);
          q += 4;
        }
        if (flags & 0x800) {
          q += 4;
        }
        duration += d;
        if (i === 0) {
          f = firstFlags ?? f;
          firstKey = f === undefined ? undefined : !(f & 0x10000);
        }
      }
    }
    out.push({
      track: id, type: track?.type, baseMediaDecodeTime: decode, baseSeconds: decode === undefined ? undefined : +(decode / scale).toFixed(3),
      samples, durationSeconds: +(duration / scale).toFixed(3), ...(track?.type === 'vide' ? { firstSampleIsKeyframe: firstKey } : {}),
    });
  }
  return out;
}

/** Writes the bytes of one recording as they are yielded, and a JSON with their timing. */
export class RecordingCapture {
  constructor(dir, log) {
    this.dir = dir;
    this.log = log;
    this.started = Date.now();
    this.name = new Date(this.started).toISOString().replace(/:/g, '-');
    this.tracks = [];
    this.fragments = [];
    this.stream = undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      this.stream = createWriteStream(join(dir, `${this.name}.mp4`), { mode: 0o600 });
      this.stream.on('error', () => {});
    } catch (error) {
      log.warn(`Could not save recordings to ${dir}: ${error.message}`);
    }
  }

  add(data) {
    const index = this.fragments.length;
    const entry = { index, kind: index === 0 ? 'init' : 'fragment', bytes: data.length, yieldedMs: Date.now() - this.started };
    if (index === 0) {
      this.tracks = initTracks(data);
      entry.tracks = this.tracks;
    } else {
      try {
        entry.tracks = fragmentInfo(data, this.tracks);
      } catch (error) {
        entry.parseError = error.message;
      }
    }
    this.fragments.push(entry);
    this.stream?.write(data);
  }

  finish(extra = {}) {
    if (!this.stream) {
      return;
    }
    this.stream.end();
    try {
      writeFileSync(join(this.dir, `${this.name}.json`), JSON.stringify({ started: new Date(this.started).toISOString(), ...extra, fragments: this.fragments }, null, 2), { mode: 0o600 });
      const files = readdirSync(this.dir).filter(f => f.endsWith('.mp4')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - KEEP))) {
        rmSync(join(this.dir, old), { force: true });
        rmSync(join(this.dir, old.replace(/\.mp4$/, '.json')), { force: true });
      }
      this.log.info(`Recording saved to ${join(this.dir, `${this.name}.mp4`)} (and .json with the fragment timing).`);
    } catch (error) {
      this.log.warn(`Could not save the recording's details: ${error.message}`);
    }
  }
}
