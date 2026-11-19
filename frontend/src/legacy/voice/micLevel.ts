// src/legacy/voice/micLevel.ts — shared microphone stream + RMS level meter.

export class MicMeter {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private data: Float32Array<ArrayBuffer> | null = null;
  stream: MediaStream | null = null;

  async open(): Promise<MediaStream> {
    if (this.stream) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.data = new Float32Array(this.analyser.fftSize);
    src.connect(this.analyser);
    return this.stream;
  }

  /** Current RMS level, roughly 0..1 for normal speech. */
  level(): number {
    if (!this.analyser || !this.data) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
    return Math.min(1, Math.sqrt(sum / this.data.length) * 6);
  }

  watch(cb: (level: number) => void) {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      cb(this.level());
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  unwatch() {
    cancelAnimationFrame(this.raf);
  }

  setMuted(muted: boolean) {
    this.stream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  }

  close() {
    this.unwatch();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.analyser = null;
  }
}
