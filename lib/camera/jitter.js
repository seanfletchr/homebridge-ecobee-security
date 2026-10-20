// RTP reordering buffer: hands packets on in sequence order. An out-of-order packet is held until the
// ones before it arrive; if a missing packet doesn't show up within `waitMs` it is given up on
// (reported through `onSkip`) and the packets after it go on. Duplicates and packets that arrive
// after their turn has passed are dropped.

// How long to wait for a packet that went missing: ecobee's camera answers a NACK (a retransmit) after 100 to 500 ms on a
// busy network. Packets after a gap are held back meanwhile, so a live view runs this much behind after a loss and no more.
export const JITTER_WAIT = 600;
const MAX_HELD = 1024;
// A jump this far ahead is a restarted stream, not a gap worth waiting for.
const RESYNC_DISTANCE = 3000;
// This many packets in a row that look "late": the sender's numbering restarted, not a run of stragglers.
const LATE_RUN = 60;

export class JitterBuffer {
  /**
   * @param {object} options
   * @param {(packet: any) => void} options.onPacket called for each packet, in order
   * @param {(count: number) => void} [options.onSkip] called with the number of packets given up on
   * @param {number} [options.waitMs] how long to wait for a missing packet (a late retransmit counts as `recovered`)
   */
  constructor({ onPacket, onSkip = () => {}, waitMs = JITTER_WAIT }) {
    this.onPacket = onPacket;
    this.onSkip = onSkip;
    this.waitMs = waitMs;
    this.expected = undefined;
    this.held = new Map();
    this.timer = undefined;
    this.late = 0;
    this.recovered = 0;
    this.lateRun = 0;
  }

  /** @param {number} seq 16-bit RTP sequence number */
  push(seq, packet) {
    if (this.expected === undefined) {
      this.expected = seq;
    }
    const ahead = (seq - this.expected) & 0xffff;
    if (ahead >= 0x8000) {
      this.late++; // duplicate, or too late to be of use
      if (++this.lateRun >= LATE_RUN) {
        this.reset();
        this.expected = seq;
        this.emit(seq, packet);
      }
      return;
    }
    this.lateRun = 0;
    if (ahead > RESYNC_DISTANCE) {
      this.reset();
      this.expected = seq;
      this.emit(seq, packet);
      return;
    }
    if (ahead === 0) {
      if (this.held.size) {
        this.recovered++; // the packet everything behind was waiting for
      }
      this.emit(seq, packet);
      this.drain();
      return;
    }
    if (this.held.has(seq)) {
      this.late++;
      return;
    }
    for (const other of this.held.keys()) {
      if (((other - seq) & 0xffff) < 0x8000) {
        this.recovered++; // arrived out of order, into a gap that is still open
        break;
      }
    }
    this.held.set(seq, { packet, at: Date.now() });
    if (this.held.size > MAX_HELD) {
      this.skip();
    } else if (!this.timer) {
      this.schedule();
    }
  }

  /**
   * Give up on the gap at the head when the first packet held behind it has waited `waitMs`: counted from when
   * that packet arrived, so a gap isn't skipped early because an older one set the timer.
   */
  schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.held.size) {
      return;
    }
    let at = Infinity;
    let distance = Infinity;
    for (const [seq, item] of this.held) {
      const d = (seq - this.expected) & 0xffff;
      if (d < distance) {
        distance = d;
        at = item.at;
      }
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.skip();
    }, Math.max(0, at + this.waitMs - Date.now()));
  }

  emit(seq, packet) {
    this.expected = (seq + 1) & 0xffff;
    this.onPacket(packet);
  }

  /** Emit held packets that are now next in line; keep the timer for what's still waiting. */
  drain() {
    while (this.held.has(this.expected)) {
      const seq = this.expected;
      const { packet } = this.held.get(seq);
      this.held.delete(seq);
      this.emit(seq, packet);
    }
    // A new gap has a new first packet behind it: its own wait.
    this.schedule();
  }

  /** Give up on what's missing: carry on from the nearest held packet. */
  skip() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.held.size) {
      return;
    }
    let nearest;
    let distance = Infinity;
    for (const seq of this.held.keys()) {
      const d = (seq - this.expected) & 0xffff;
      if (d < distance) {
        distance = d;
        nearest = seq;
      }
    }
    this.onSkip(distance);
    this.expected = nearest;
    this.drain();
  }

  reset() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.held.clear();
    this.expected = undefined;
    this.lateRun = 0;
  }
}
