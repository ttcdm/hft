// High-Frequency Trading Audio Synthesizer via Web Audio API
class HftAudioSynthesizer {
  private ctx: AudioContext | null = null;
  private enabled: boolean = true;

  constructor() {
    // Lazy audio context init on user gesture
  }

  public setEnabled(val: boolean) {
    this.enabled = val;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private lastTradeSoundTime: number = 0;

  // Soft micro-tick click when trade fills (rate-limited to avoid audio node explosion and memory leaks)
  public playTradeFill(isBuy: boolean) {
    if (!this.enabled) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (now - this.lastTradeSoundTime < 200) {
      return; // Cap audio ticks to max ~5/sec
    }
    this.lastTradeSoundTime = now;

    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(isBuy ? 1200 : 800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(isBuy ? 1600 : 600, ctx.currentTime + 0.04);

      gain.gain.setValueAtTime(0.04, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.04);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {}
      };

      osc.start();
      osc.stop(ctx.currentTime + 0.045);
    } catch {
      // Audio play error safe guard
    }
  }

  // Alert warning ping
  public playAlertBeep(level: 'WARNING' | 'CRITICAL') {
    if (!this.enabled) return;
    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = level === 'CRITICAL' ? 'sawtooth' : 'triangle';
      const freq = level === 'CRITICAL' ? 880 : 540;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.frequency.setValueAtTime(freq * 1.5, ctx.currentTime + 0.08);

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {}
      };

      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    } catch {
      // safe guard
    }
  }

  // Emergency Kill Switch trigger sound
  public playKillSwitch() {
    if (!this.enabled) return;
    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.35);

      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {}
      };

      osc.start();
      osc.stop(ctx.currentTime + 0.36);
    } catch {
      // safe guard
    }
  }

  // Quick soft tick on UI action
  public playClick() {
    if (!this.enabled) return;
    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1600, ctx.currentTime);
      gain.gain.setValueAtTime(0.02, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.02);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {}
      };

      osc.start();
      osc.stop(ctx.currentTime + 0.025);
    } catch {}
  }

  public playOrderFill(isBuy: boolean = true) {
    this.playTradeFill(isBuy);
  }

  public playAlert(level: 'WARNING' | 'CRITICAL' = 'WARNING') {
    this.playAlertBeep(level);
  }
}

export const hftAudio = new HftAudioSynthesizer();
