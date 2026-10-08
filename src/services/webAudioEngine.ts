type AudioContextWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

const BEAT_ANALYSER_FFT_SIZE = 2048;
const VOLUME_RAMP_SECONDS = 0.02;

export class WebAudioEngine {
  private ctx: AudioContext | null = null;
  private element: HTMLAudioElement | null = null;
  private analyser: AnalyserNode | null = null;
  private volumeGain: GainNode | null = null;

  static isSupported(): boolean {
    if (typeof window === 'undefined') return false;
    const audioWindow = window as AudioContextWindow;
    return Boolean(audioWindow.AudioContext || audioWindow.webkitAudioContext);
  }

  constructor(element: HTMLAudioElement) {
    this.element = element;
    this.build();
  }

  private build() {
    const audioWindow = window as AudioContextWindow;
    const AudioContextConstructor =
      audioWindow.AudioContext || audioWindow.webkitAudioContext;

    if (!AudioContextConstructor || !this.element) {
      console.warn('Web Audio API indisponible — analyse audio désactivée.');
      return;
    }

    const context = new AudioContextConstructor();
    this.ctx = context;

    this.element.crossOrigin = 'anonymous';
    this.element.preload = 'auto';

    const source = context.createMediaElementSource(this.element);
    const analyser = context.createAnalyser();
    const volumeGain = context.createGain();
    this.analyser = analyser;
    this.volumeGain = volumeGain;
    analyser.fftSize = BEAT_ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    volumeGain.gain.value = 1;

    source.connect(volumeGain);
    volumeGain.connect(analyser);
    analyser.connect(context.destination);
  }

  getTimeDomainData(target: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> | null {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(target);
    return target;
  }

  setVolume(volumePercent: number) {
    const volume = Math.max(0, Math.min(100, volumePercent)) / 100;
    if (this.ctx && this.volumeGain) {
      this.volumeGain.gain.setTargetAtTime(
        volume,
        this.ctx.currentTime,
        VOLUME_RAMP_SECONDS
      );
      if (this.element) this.element.volume = 1;
    } else if (this.element) {
      this.element.volume = volume;
    }
  }

  async resume() {
    if (this.ctx?.state === 'suspended') {
      await this.ctx.resume();
    }
    if (this.element?.paused) {
      await this.element.play();
    }
  }

  getContextState(): string {
    return this.ctx?.state ?? 'none';
  }

  async destroy() {
    if (this.ctx) {
      await this.ctx.close();
    }
    this.ctx = null;
    this.element = null;
    this.analyser = null;
    this.volumeGain = null;
  }
}
