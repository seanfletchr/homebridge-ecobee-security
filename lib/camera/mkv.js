// A minimal streaming Matroska writer: enough for ffmpeg to read H.264 and Opus with their timing from a
// pipe (Segment and Clusters of unknown size, SimpleBlocks). The recorder feeds ffmpeg with this so the
// camera's real frame times survive the trip to fragmented MP4.

import { parseSps } from './h264.js';

const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

/** EBML element id bytes: kept as written in the spec (they include their length marker). */
const id = hex => Buffer.from(hex, 'hex');

function size(n) {
  // 8-byte length keeps this simple and always valid.
  const b = Buffer.alloc(8);
  b.writeUInt32BE(Math.floor(n / 2 ** 32) | 0x01000000, 0);
  b.writeUInt32BE(n % 2 ** 32, 4);
  return b;
}

const element = (idHex, ...payload) => {
  const body = Buffer.concat(payload);
  return Buffer.concat([id(idHex), size(body.length), body]);
};

function uint(n) {
  if (n === 0) {
    return Buffer.from([0]);
  }
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) {
    bytes.unshift(v % 256);
  }
  return Buffer.from(bytes);
}

const uintElement = (idHex, n) => element(idHex, uint(n));
const stringElement = (idHex, s) => element(idHex, Buffer.from(s, 'ascii'));
const floatElement = (idHex, f) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(f);
  return element(idHex, b);
};

/** avcC (AVCDecoderConfigurationRecord) from one SPS and one PPS NAL. */
export function avcC(sps, pps) {
  return Buffer.concat([
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]), sps,
    Buffer.from([1, pps.length >> 8, pps.length & 0xff]), pps,
  ]);
}

export function opusHead(channels) {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'ascii');
  b[8] = 1;
  b[9] = channels;
  b.writeUInt16LE(312, 10);
  b.writeUInt32LE(48000, 12);
  b.writeInt16LE(0, 16);
  b[18] = 0;
  return b;
}

export const VIDEO_TRACK = 1;
export const AUDIO_TRACK = 2;

export class MkvWriter {
  /**
   * @param {object} options
   * @param {Buffer} options.sps
   * @param {Buffer} options.pps
   * @param {number} options.start ms: the time of the first frame (block times are written relative to it)
   * @param {number} [options.opusChannels] 1 or 2 to include an Opus track, 0 / undefined for video only
   */
  constructor({ sps, pps, start, opusChannels = 0 }) {
    this.sps = sps;
    this.pps = pps;
    this.start = start;
    this.opusChannels = opusChannels;
    this.clusterAt = undefined;
  }

  /** EBML header, the start of the Segment, Info and Tracks. */
  header() {
    const dims = parseSps(this.sps) ?? { width: 0, height: 0 };
    const ebml = element('1A45DFA3',
      uintElement('4286', 1), uintElement('42F7', 1), uintElement('42F2', 4), uintElement('42F3', 8),
      stringElement('4282', 'matroska'), uintElement('4287', 4), uintElement('4285', 2));
    const info = element('1549A966', uintElement('2AD7B1', 1000000), stringElement('4D80', 'ecobee'), stringElement('5741', 'ecobee'));
    const video = element('AE',
      uintElement('D7', VIDEO_TRACK), uintElement('73C5', VIDEO_TRACK), uintElement('83', 1), uintElement('9C', 0),
      stringElement('86', 'V_MPEG4/ISO/AVC'), element('63A2', avcC(this.sps, this.pps)),
      element('E0', uintElement('B0', dims.width), uintElement('BA', dims.height)));
    const tracks = [video];
    if (this.opusChannels) {
      tracks.push(element('AE',
        uintElement('D7', AUDIO_TRACK), uintElement('73C5', AUDIO_TRACK), uintElement('83', 2), uintElement('9C', 0),
        stringElement('86', 'A_OPUS'), element('63A2', opusHead(this.opusChannels)),
        uintElement('56AA', 6500000), uintElement('56BB', 80000000),
        element('E1', floatElement('B5', 48000), uintElement('9F', this.opusChannels))));
    }
    return Buffer.concat([ebml, id('18538067'), UNKNOWN, info, element('1654AE6B', ...tracks)]);
  }

  /**
   * One frame or packet as a SimpleBlock, preceded by a new Cluster when needed.
   * @param {number} track VIDEO_TRACK or AUDIO_TRACK
   * @param {number} time ms
   * @param {Buffer} data H.264 access unit with 4-byte NAL lengths, or an Opus packet
   * @param {boolean} key
   */
  block(track, time, data, key = false) {
    const parts = [];
    const t = Math.max(0, Math.round(time - this.start));
    if (this.clusterAt === undefined || (track === VIDEO_TRACK && key) || t - this.clusterAt > 20000 || t < this.clusterAt - 30000) {
      this.clusterAt = t;
      parts.push(id('1F43B675'), UNKNOWN, uintElement('E7', t));
    }
    const head = Buffer.alloc(4);
    head[0] = 0x80 | track;
    head.writeInt16BE(Math.max(-32768, Math.min(32767, t - this.clusterAt)), 1);
    head[3] = key ? 0x80 : 0;
    parts.push(element('A3', head, data));
    return Buffer.concat(parts);
  }
}
