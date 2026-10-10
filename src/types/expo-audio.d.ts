import 'expo-audio/build/AudioModule.types';

declare module 'expo-audio/build/AudioModule.types' {
  interface AudioPlayer {
    setDSP(enabled: boolean, bands: number[], preamp: number, balance: number, stereo: number, limit: boolean, reverb: boolean, room: number, damp: number, mix: number): void;
  }
}
