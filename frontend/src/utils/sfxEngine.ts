// src/utils/sfxEngine.ts
// Web Audio API procedural SFX & soundscape engine for in-browser theater player

type SFXType = 'rain' | 'ocean' | 'forest' | 'fireplace' | 'space' | 'cinematic';

class SFXEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private activeNodes: (AudioNode | { stop: () => void })[] = [];
  private currentType: SFXType | null = null;
  private volume: number = 0.22; // subtle background volume under narration

  private getContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.1);
    }
  }

  public stopSFX() {
    if (!this.ctx || !this.masterGain) return;
    try {
      this.masterGain.gain.setTargetAtTime(0.001, this.ctx.currentTime, 0.2);
      setTimeout(() => {
        this.activeNodes.forEach((node) => {
          try {
            if ('stop' in node && typeof node.stop === 'function') {
              node.stop();
            }
            if ('disconnect' in node && typeof node.disconnect === 'function') {
              node.disconnect();
            }
          } catch {}
        });
        this.activeNodes = [];
        this.currentType = null;
      }, 250);
    } catch {}
  }

  public playSFX(sfxText: string, mode: string) {
    const type = this.detectSFXType(sfxText, mode);
    if (this.currentType === type && this.activeNodes.length > 0) return; // already playing this soundscape

    this.stopSFX();

    setTimeout(() => {
      const ctx = this.getContext();
      this.masterGain = ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.001, ctx.currentTime);
      this.masterGain.gain.setTargetAtTime(this.volume, ctx.currentTime, 0.3);
      this.masterGain.connect(ctx.destination);
      this.currentType = type;

      switch (type) {
        case 'rain':
          this.buildRain(ctx, this.masterGain);
          break;
        case 'ocean':
          this.buildOcean(ctx, this.masterGain);
          break;
        case 'forest':
          this.buildForest(ctx, this.masterGain);
          break;
        case 'fireplace':
          this.buildFireplace(ctx, this.masterGain);
          break;
        case 'space':
          this.buildSpace(ctx, this.masterGain);
          break;
        case 'cinematic':
        default:
          this.buildCinematicPad(ctx, this.masterGain);
          break;
      }
    }, 100);
  }

  private detectSFXType(sfxText: string, mode: string): SFXType {
    const text = (sfxText || '').toLowerCase();
    if (text.includes('rain') || text.includes('storm') || text.includes('thunder') || text.includes('drizzle')) return 'rain';
    if (text.includes('ocean') || text.includes('wave') || text.includes('sea') || text.includes('water')) return 'ocean';
    if (text.includes('forest') || text.includes('bird') || text.includes('nature') || text.includes('park') || text.includes('wind')) return 'forest';
    if (text.includes('fire') || text.includes('hearth') || text.includes('fireplace') || text.includes('cozy') || text.includes('storybook')) return 'fireplace';
    if (text.includes('space') || text.includes('star') || text.includes('alien') || text.includes('ship') || text.includes('sci-fi')) return 'space';
    
    if (mode === 'storybook') return 'fireplace';
    if (mode === 'documentary') return 'forest';
    if (mode === 'animated') return 'space';
    return 'cinematic';
  }

  // ── 1. Rain & Thunder Soundscape ──────────────────────────────────────────
  private buildRain(ctx: AudioContext, destination: GainNode) {
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1000;

    whiteNoise.connect(filter);
    filter.connect(destination);
    whiteNoise.start();
    this.activeNodes.push(whiteNoise, filter);
  }

  // ── 2. Ocean Waves Soundscape ──────────────────────────────────────────────
  private buildOcean(ctx: AudioContext, destination: GainNode) {
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      output[i] = (lastOut + 0.02 * white) / 1.02;
      lastOut = output[i];
      output[i] *= 3.5;
    }

    const brownNoise = ctx.createBufferSource();
    brownNoise.buffer = noiseBuffer;
    brownNoise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 350;

    // LFO for wave modulation
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12; // wave cycle ~8 seconds
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 250;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    brownNoise.connect(filter);
    filter.connect(destination);
    lfo.start();
    brownNoise.start();
    this.activeNodes.push(brownNoise, filter, lfo, lfoGain);
  }

  // ── 3. Forest & Nature Ambiance ───────────────────────────────────────────
  private buildForest(ctx: AudioContext, destination: GainNode) {
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 500;
    filter.Q.value = 2.0;

    noise.connect(filter);
    filter.connect(destination);
    noise.start();
    this.activeNodes.push(noise, filter);
  }

  // ── 4. Cozy Fireplace Crackle ─────────────────────────────────────────────
  private buildFireplace(ctx: AudioContext, destination: GainNode) {
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) output[i] = (Math.random() * 2 - 1) * 0.15;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;

    noise.connect(filter);
    filter.connect(destination);
    noise.start();
    this.activeNodes.push(noise, filter);
  }

  // ── 5. Sci-Fi Space Drone ──────────────────────────────────────────────────
  private buildSpace(ctx: AudioContext, destination: GainNode) {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.value = 55;  // A1 low drone
    osc2.frequency.value = 110; // A2 harmonic

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 200;

    const gain1 = ctx.createGain();
    gain1.gain.value = 0.5;

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain1);
    gain1.connect(destination);

    osc1.start();
    osc2.start();
    this.activeNodes.push(osc1, osc2, filter, gain1);
  }

  // ── 6. Cinematic Sub-Harmonic Pad ──────────────────────────────────────────
  private buildCinematicPad(ctx: AudioContext, destination: GainNode) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 65; // C2 deep warm bass pad

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 180;

    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.35;

    osc.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(destination);

    osc.start();
    this.activeNodes.push(osc, filter, gainNode);
  }
}

export const sfxEngine = new SFXEngine();
