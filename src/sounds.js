// Tiny synthesized sound effects via WebAudio -- no audio files needed.
// The AudioContext is created lazily on the first user gesture.

export class Sounds {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
  }

  _ctx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  _tone(freqStart, freqEnd, duration, { type = 'sine', volume = 0.15, delay = 0 } = {}) {
    if (!this.enabled) return;
    const ctx = this._ctx();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  place()  { this._tone(420, 620, 0.09, { type: 'sine', volume: 0.18 }); }
  erase()  { this._tone(300, 130, 0.12, { type: 'triangle', volume: 0.18 }); }
  paint()  { this._tone(520, 700, 0.07, { type: 'sine', volume: 0.12 }); }
  click()  { this._tone(700, 500, 0.05, { type: 'square', volume: 0.05 }); }
  no()     { this._tone(180, 140, 0.15, { type: 'sawtooth', volume: 0.08 }); }
  undo()   { this._tone(500, 350, 0.08, { type: 'sine', volume: 0.1 }); }

  tada() {
    // Little victory arpeggio: C5 E5 G5 C6.
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      this._tone(f, f, 0.22, { type: 'triangle', volume: 0.14, delay: i * 0.09 });
    });
  }
}
