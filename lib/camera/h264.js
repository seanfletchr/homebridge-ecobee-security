// H.264 over RTP (RFC 6184: single NAL, STAP-A, FU-A) to Annex-B access units.

export const START_CODE = Buffer.from([0, 0, 0, 1]);

export class Depacketizer {
  /**
   * @param {(nals: Buffer[], timestamp: number) => void} onAccessUnit a complete, undamaged frame
   * @param {(lost: number, dropped?: boolean, wasKeyframe?: boolean) => void} [onGap] packets lost / a damaged frame dropped
   */
  constructor(onAccessUnit, onGap = () => {}) {
    this.onAccessUnit = onAccessUnit;
    this.onGap = onGap;
    this.lastSeq = undefined;
    this.ts = undefined;
    this.nals = [];
    this.fu = undefined;
    this.damaged = false;
    this.hasKey = false;
  }

  /** @param {{header: {sequenceNumber: number, timestamp: number, marker: boolean}, payload: Buffer}} p */
  push(p) {
    const { sequenceNumber: seq, timestamp, marker } = p.header;
    if (this.lastSeq !== undefined && ((seq - this.lastSeq) & 0xffff) > 0x8000) {
      return;
    }
    if (this.lastSeq !== undefined && seq !== ((this.lastSeq + 1) & 0xffff)) {
      this.onGap(((seq - this.lastSeq - 1) & 0xffff) || 0);
      this.damaged = true;
      this.fu = undefined;
    }
    this.lastSeq = seq;
    if (this.ts !== undefined && timestamp !== this.ts) {
      // A new frame without the marker of the previous one: that one is incomplete.
      if (this.nals.length || this.fu) {
        this.onGap(0, true, this.hasKey);
      }
      this.hasKey = false;
      this.nals = [];
      this.fu = undefined;
      this.damaged = false;
    }
    this.ts = timestamp;
    const payload = p.payload;
    if (!payload?.length) {
      return;
    }
    const type = payload[0] & 0x1f;
    if (type === 5) {
      this.hasKey = true;
    } else if (type === 28 && payload.length > 1 && (payload[1] & 0x80) && (payload[1] & 0x1f) === 5) {
      this.hasKey = true;
    } else if (type === 24) {
      for (let o = 1; o + 3 <= payload.length; o += 2 + payload.readUInt16BE(o)) {
        if ((payload[o + 2] & 0x1f) === 5) {
          this.hasKey = true;
        }
      }
    }
    if (type >= 1 && type <= 23) {
      this.nals.push(payload);
    } else if (type === 24) {
      let o = 1;
      while (o + 2 <= payload.length) {
        const len = payload.readUInt16BE(o);
        o += 2;
        if (!len || o + len > payload.length) {
          break;
        }
        this.nals.push(payload.subarray(o, o + len));
        o += len;
      }
    } else if (type === 28 && payload.length > 2) {
      const start = payload[1] & 0x80;
      const end = payload[1] & 0x40;
      if (start) {
        this.fu = [Buffer.from([(payload[0] & 0xe0) | (payload[1] & 0x1f)]), payload.subarray(2)];
      } else if (this.fu) {
        this.fu.push(payload.subarray(2));
      } else {
        this.damaged = true;
      }
      if (end && this.fu) {
        this.nals.push(Buffer.concat(this.fu));
        this.fu = undefined;
      }
    }
    if (marker) {
      if (!this.damaged && this.nals.length) {
        this.onAccessUnit(this.nals, timestamp);
      } else {
        this.onGap(0, true, this.hasKey);
      }
      this.hasKey = false;
      this.nals = [];
      this.damaged = false;
      this.fu = undefined;
    }
  }
}

/** Annex-B bytes for a frame: SPS and PPS first (from the frame, or the last seen), then the rest. */
export function annexB(nals, sps, pps) {
  const parts = [];
  const has = t => nals.some(n => (n[0] & 0x1f) === t);
  if (!has(7) && sps) {
    parts.push(START_CODE, sps);
  }
  if (!has(8) && pps) {
    parts.push(START_CODE, pps);
  }
  for (const n of nals) {
    parts.push(START_CODE, n);
  }
  return Buffer.concat(parts);
}

/** Parse an RTP packet (RFC 3550) into what the depacketizer wants. */
export function parseRtp(buf) {
  // Not RTP, or an RTCP packet (types 200-204 look like payload types 72-76 here).
  if (buf.length < 12 || buf[0] >> 6 !== 2 || (buf[1] & 0x7f) >= 72 && (buf[1] & 0x7f) <= 76) {
    return undefined;
  }
  let offset = 12 + (buf[0] & 0x0f) * 4;
  if (buf[0] & 0x10) {
    if (buf.length < offset + 4) {
      return undefined;
    }
    offset += 4 + buf.readUInt16BE(offset + 2) * 4;
  }
  let end = buf.length;
  if (buf[0] & 0x20) {
    end -= buf[buf.length - 1];
  }
  if (offset > end) {
    return undefined;
  }
  return {
    header: {
      sequenceNumber: buf.readUInt16BE(2),
      timestamp: buf.readUInt32BE(4),
      marker: Boolean(buf[1] & 0x80),
      ssrc: buf.readUInt32BE(8),
      payloadType: buf[1] & 0x7f,
    },
    payload: buf.subarray(offset, end),
  };
}

/** Width and height from an SPS NAL (with its header byte). */
export function parseSps(nal) {
  // Drop emulation prevention bytes.
  const bytes = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) {
      continue;
    }
    bytes.push(nal[i]);
  }
  let pos = 0;
  const bit = () => {
    const value = (bytes[pos >> 3] >> (7 - (pos & 7))) & 1;
    pos++;
    return value;
  };
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | bit();
    }
    return v;
  };
  const ue = () => {
    let zeros = 0;
    while (bit() === 0 && zeros < 32) {
      zeros++;
    }
    return (2 ** zeros) - 1 + bits(zeros);
  };
  const se = () => {
    const k = ue();
    return k % 2 ? (k + 1) / 2 : -k / 2;
  };
  try {
    const profile = bits(8);
    bits(8);
    bits(8);
    ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue();
      if (chroma === 3) {
        bit();
      }
      ue();
      ue();
      bit();
      if (bit()) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (bit()) {
            let last = 8;
            let next = 8;
            for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
              if (next !== 0) {
                next = (last + se() + 256) % 256;
              }
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    ue();
    const pocType = ue();
    if (pocType === 0) {
      ue();
    } else if (pocType === 1) {
      bit();
      se();
      se();
      const n = ue();
      for (let i = 0; i < n; i++) {
        se();
      }
    }
    ue();
    bit();
    const w = ue() + 1;
    const h = ue() + 1;
    const frameMbsOnly = bit();
    if (!frameMbsOnly) {
      bit();
    }
    bit();
    let crop = [0, 0, 0, 0];
    if (bit()) {
      crop = [ue(), ue(), ue(), ue()];
    }
    const unitX = chroma === 0 || chroma === 3 ? 1 : 2;
    const unitY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return { width: w * 16 - unitX * (crop[0] + crop[1]), height: (2 - frameMbsOnly) * h * 16 - unitY * (crop[2] + crop[3]) };
  } catch {
    return undefined;
  }
}
