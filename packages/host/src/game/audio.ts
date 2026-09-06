/**
 * Procedural sound. No files, no loading, no assets to source.
 *
 * Feel is mostly feedback, and silence is the single biggest thing missing from
 * the last build. Synthesised impacts are not a substitute for a real sound
 * pack, but they are enormously better than nothing and they cost zero bytes.
 *
 * Everything is built from noise bursts and short pitch sweeps through a gain
 * envelope, which is what most impact sounds are anyway.
 */

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  /** Browsers block audio until a user gesture; call this from one. */
  resume(): void {
    void this.ctx?.resume();
  }

  private ensure(): boolean {
    if (this.ctx) return true;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);

      // One second of white noise, reused for every impact.
      const frames = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  private now(): number {
    return this.ctx!.currentTime;
  }

  /** A filtered burst of noise — the body of any impact. */
  private burst(opts: {
    gain: number;
    duration: number;
    filter: number;
    filterEnd?: number;
    type?: BiquadFilterType;
  }): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? 'lowpass';
    filter.frequency.setValueAtTime(opts.filter, this.now());
    if (opts.filterEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(40, opts.filterEnd),
        this.now() + opts.duration,
      );
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain, this.now());
    gain.gain.exponentialRampToValueAtTime(0.0001, this.now() + opts.duration);

    src.connect(filter).connect(gain).connect(this.master!);
    src.start();
    src.stop(this.now() + opts.duration);
  }

  /** A pitched sweep — the "weight" under an impact, or a UI blip. */
  private tone(opts: {
    from: number;
    to: number;
    gain: number;
    duration: number;
    type?: OscillatorType;
  }): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.from, this.now());
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), this.now() + opts.duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain, this.now());
    gain.gain.exponentialRampToValueAtTime(0.0001, this.now() + opts.duration);

    osc.connect(gain).connect(this.master!);
    osc.start();
    osc.stop(this.now() + opts.duration);
  }

  /** A connecting punch. `power` 0..1 scales weight and brightness. */
  punchHit(power = 1): void {
    if (!this.ensure()) return;
    this.burst({ gain: 0.75 * power, duration: 0.16, filter: 2600, filterEnd: 260 });
    this.tone({ from: 190 * (0.85 + power * 0.3), to: 44, gain: 0.6 * power, duration: 0.19 });
  }

  /** A punch that hits nothing. Quieter and airier, so whiffing reads. */
  punchWhiff(): void {
    if (!this.ensure()) return;
    this.burst({ gain: 0.16, duration: 0.13, filter: 900, filterEnd: 2600, type: 'bandpass' });
  }

  grab(): void {
    if (!this.ensure()) return;
    this.burst({ gain: 0.3, duration: 0.06, filter: 1800, filterEnd: 700 });
    this.tone({ from: 420, to: 300, gain: 0.16, duration: 0.07, type: 'square' });
  }

  throwing(): void {
    if (!this.ensure()) return;
    this.burst({ gain: 0.34, duration: 0.26, filter: 400, filterEnd: 3200, type: 'bandpass' });
  }

  /** Body hitting the ground. `power` scales with impact speed. */
  land(power = 1): void {
    if (!this.ensure()) return;
    this.burst({ gain: 0.3 * power, duration: 0.13, filter: 700, filterEnd: 130 });
    this.tone({ from: 110, to: 40, gain: 0.34 * power, duration: 0.16 });
  }

  /** Falling off the stage — a comic descending tone. */
  fall(): void {
    if (!this.ensure()) return;
    this.tone({ from: 700, to: 90, gain: 0.35, duration: 0.85, type: 'triangle' });
  }

  countdownTick(): void {
    if (!this.ensure()) return;
    this.tone({ from: 660, to: 660, gain: 0.24, duration: 0.09, type: 'square' });
  }

  countdownGo(): void {
    if (!this.ensure()) return;
    this.tone({ from: 990, to: 990, gain: 0.3, duration: 0.22, type: 'square' });
  }

  /** Short major arpeggio for the winner. */
  fanfare(): void {
    if (!this.ensure()) return;
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      setTimeout(() => {
        if (!this.ctx) return;
        this.tone({ from: f, to: f, gain: 0.26, duration: 0.22, type: 'triangle' });
      }, i * 95);
    });
  }
}
