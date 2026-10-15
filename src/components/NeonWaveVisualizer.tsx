import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Platform,
  useWindowDimensions,
  AppState,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { beatStore } from '../services/beatStore';

export interface NeonWaveVisualizerProps {
  height?: number;
  isActive?: boolean;
  hasTrack?: boolean;
  /**
   * Mode d'affichage du visualiseur :
   * - 'bars' : Spectre audio haute définition en barres avec pics de crête et réflexion
   * - 'wave' : Onde sinusoïdale néon fluide avec rubans et étincelles réactives
   */
  mode?: 'bars' | 'wave';
  /**
   * Réactivité du visualiseur aux basses.
   */
  spectrumReactive?: 'low' | 'normal' | 'ultra';
}

const SPECTRUM_PROFILES = {
  low: { attack: 0.65, decay: 0.14, bounce: 0.85, waveAmp: 0.8 },
  normal: { attack: 0.78, decay: 0.17, bounce: 1.0, waveAmp: 1.0 },
  ultra: { attack: 0.92, decay: 0.22, bounce: 1.25, waveAmp: 1.3 },
} as const;

// Pré-calcul de variations naturelles entre barres pour reproduire le relief fidèle
const MAX_BARS = 80;
const BAR_SEEDS: number[] = [];
for (let i = 0; i < MAX_BARS; i++) {
  const n = Math.sin((i + 5) * 47.19) * 43758.5453;
  const rand = n - Math.floor(n);
  BAR_SEEDS.push(0.85 + rand * 0.30);
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  phase: number;
}

export const NeonWaveVisualizer: React.FC<NeonWaveVisualizerProps> = ({
  height: propHeight,
  isActive: propIsActive,
  hasTrack = true,
  mode = 'bars',
  spectrumReactive = 'normal',
}) => {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [layoutWidth, setLayoutWidth] = useState<number>(windowWidth || 360);
  const canvasRef = useRef<any>(null);
  const pathRef = useRef<any>(null);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const isActiveRef = useRef(propIsActive);
  isActiveRef.current = propIsActive;
  const hasTrackRef = useRef(hasTrack);
  hasTrackRef.current = hasTrack;
  const spectrumRef = useRef(spectrumReactive);
  spectrumRef.current = spectrumReactive;

  const containerHeight = useMemo(() => {
    if (propHeight && propHeight > 0) return propHeight;
    const maxH = Math.round(windowHeight * 0.28);
    return Math.min(270, Math.max(160, maxH));
  }, [propHeight, windowHeight]);

  const width = layoutWidth > 0 ? layoutWidth : windowWidth || 360;
  const height = containerHeight;

  useEffect(() => {
    let animId: number | null = null;
    let cancelled = false;

    let phase = 0;
    let smoothedPulse = 0;
    let smoothedEnergy = 0;
    let lastTime = performance.now();

    // Tableaux de lissage pour les barres
    const currentHeights = new Float32Array(MAX_BARS);
    const peakHeights = new Float32Array(MAX_BARS);
    const peakVelocities = new Float32Array(MAX_BARS);

    // Étincelles pour le mode 'wave'
    const sparks: Spark[] = Array.from({ length: 20 }, () => ({
      x: Math.random() * width,
      y: height * 0.3 + Math.random() * (height * 0.4),
      vx: (Math.random() - 0.5) * 0.8,
      vy: (Math.random() - 0.5) * 0.4,
      size: 1.2 + Math.random() * 2.0,
      alpha: 0.3 + Math.random() * 0.6,
      phase: Math.random() * Math.PI * 2,
    }));

    const stopLoop = () => {
      if (animId !== null) {
        cancelAnimationFrame(animId);
        animId = null;
      }
    };

    const startLoop = () => {
      if (cancelled || animId !== null) return;
      if (Platform.OS !== 'web' && AppState.currentState !== 'active') return;
      lastTime = performance.now();
      animId = requestAnimationFrame(render);
    };

    const render = (time: number) => {
      if (cancelled) return;
      if (Platform.OS !== 'web' && AppState.currentState !== 'active') {
        animId = null;
        return;
      }

      const rawDt = (time - lastTime) / 1000;
      const dt = Math.min(0.033, Math.max(0.004, rawDt));
      lastTime = time;

      const currentMode = modeRef.current;
      const profile = SPECTRUM_PROFILES[spectrumRef.current] ?? SPECTRUM_PROFILES.normal;
      const { pulse, energy } = beatStore.read();
      const specData = beatStore.getSpectrumData();
      const hasLiveAudio = Date.now() - beatStore.lastPushAtMs < 350;

      const isPlaybackRunning =
        hasTrackRef.current &&
        (isActiveRef.current !== undefined ? isActiveRef.current : beatStore.isPlaying) &&
        beatStore.isPlaying;

      if (!isPlaybackRunning) {
        smoothedPulse += (0 - smoothedPulse) * 0.16;
        smoothedEnergy += (0 - smoothedEnergy) * 0.16;
      } else {
        if (pulse > smoothedPulse) {
          smoothedPulse += (pulse - smoothedPulse) * profile.attack;
        } else {
          smoothedPulse += (pulse - smoothedPulse) * profile.decay;
        }

        const targetEnergy = Math.max(0.12, energy);
        smoothedEnergy += (targetEnergy - smoothedEnergy) * 0.20;

        phase += dt * (1.8 + smoothedPulse * 2.2);
      }

      // ──────────────────────────────────────────────────────────────────────
      // 1. CALCUL DU MODE BARRES (SPECTRUM BARS)
      // ──────────────────────────────────────────────────────────────────────
      const horizontalPadding = 12;
      const availableWidth = width - horizontalPadding * 2;
      const barGap = Math.max(2, Math.round(width * 0.0055));
      const targetBarWidth = Math.max(3, Math.min(5, Math.round(width * 0.0105)));
      const slot = targetBarWidth + barGap;
      const numBars = Math.max(28, Math.min(MAX_BARS, Math.floor(availableWidth / slot)));

      const totalBarsWidth = numBars * slot - barGap;
      const startX = (width - totalBarsWidth) / 2;

      // Hauteur et ligne de base
      const baselineY = Math.round(height * 0.84);
      const maxBarHeight = baselineY - 14;
      const barRadius = Math.min(2.2, targetBarWidth / 2);

      const barsList: Array<{ x: number; y: number; w: number; h: number; peakY: number }> = [];

      if (currentMode === 'bars') {
        for (let i = 0; i < numBars; i++) {
          const normX = i / (numBars - 1);

          let targetNorm = 0;

          if (isPlaybackRunning) {
            if (hasLiveAudio) {
              const bassDist = normX / 0.30;
              const bassEnvelope = Math.max(0, 1 - Math.pow(Math.min(1, bassDist), 1.3));
              const bassPart = bassEnvelope * (0.20 + specData.bass * 0.50 + smoothedPulse * 0.22);

              const vocalDist = Math.abs(normX - 0.54) / 0.22;
              const vocalEnvelope = Math.max(0, 1 - Math.pow(Math.min(1, vocalDist), 1.4));
              const vocalPart = vocalEnvelope * (0.16 + specData.vocal * 0.46 + smoothedEnergy * 0.16);

              const trebleEnvelope = Math.max(0, (1 - normX) / 0.35);
              const treblePart = Math.pow(trebleEnvelope, 1.2) * (0.06 + specData.treble * 0.36);

              const binIdx = Math.min(specData.bins.length - 1, Math.floor(normX * specData.bins.length));
              const binPart = specData.bins[binIdx] * 0.32;

              const combined =
                (bassPart + vocalPart + treblePart + binPart) *
                BAR_SEEDS[i % BAR_SEEDS.length] *
                profile.bounce;

              targetNorm = Math.min(0.84, Math.max(0.03, combined * 0.78));
            } else {
              const bassEnv = Math.max(0, 1 - normX * 3.0);
              const bassHeight = Math.pow(bassEnv, 1.2) * (0.35 + smoothedPulse * 0.45);

              const midDist = Math.abs(normX - 0.56);
              const midEnv = Math.max(0, 1 - midDist * 3.4);
              const midHeight = Math.pow(midEnv, 1.3) * (0.28 + smoothedEnergy * 0.38);

              const rollOff = Math.max(0.05, 1 - Math.pow(normX, 1.8));
              const osc = Math.sin(normX * 9 + phase) * 0.12 + Math.cos(normX * 18 - phase * 1.5) * 0.08;
              const synth = (bassHeight + midHeight + 0.10 + osc) * rollOff;

              targetNorm = Math.min(
                0.82,
                Math.max(0.03, synth * BAR_SEEDS[i % BAR_SEEDS.length] * profile.bounce)
              );
            }
          } else {
            targetNorm = 0.02;
          }

          if (targetNorm > currentHeights[i]) {
            currentHeights[i] += (targetNorm - currentHeights[i]) * profile.attack;
          } else {
            currentHeights[i] += (targetNorm - currentHeights[i]) * profile.decay;
          }

          const barH = Math.max(3, currentHeights[i] * maxBarHeight);
          const barX = startX + i * slot;
          const barY = baselineY - barH;

          // Mise à jour des pics de crête flottants (Peak Caps)
          if (barH >= peakHeights[i]) {
            peakHeights[i] = barH;
            peakVelocities[i] = 0;
          } else {
            peakVelocities[i] += dt * 55; // Gravité réaliste
            peakHeights[i] = Math.max(barH, peakHeights[i] - peakVelocities[i]);
          }

          const peakY = baselineY - peakHeights[i] - 3;

          barsList.push({
            x: barX,
            y: barY,
            w: targetBarWidth,
            h: barH,
            peakY: Math.max(6, peakY),
          });
        }
      }

      // ──────────────────────────────────────────────────────────────────────
      // 2. RENDU CANVAS WEB 120 FPS
      // ──────────────────────────────────────────────────────────────────────
      if (Platform.OS === 'web' && canvasRef.current) {
        const canvas = canvasRef.current as HTMLCanvasElement;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const displayWidth = width;
          const displayHeight = height;

          if (canvas.width !== displayWidth * dpr || canvas.height !== displayHeight * dpr) {
            canvas.width = displayWidth * dpr;
            canvas.height = displayHeight * dpr;
          }

          ctx.save();
          ctx.scale(dpr, dpr);
          ctx.clearRect(0, 0, displayWidth, displayHeight);

          if (currentMode === 'bars') {
            // MODE BARRES : barres blanches + pics de crête + reflet miroir au sol
            for (let i = 0; i < barsList.length; i++) {
              const b = barsList[i];
              const r = barRadius;

              // 1. Barre principale
              ctx.fillStyle = '#FFFFFF';
              ctx.beginPath();
              ctx.moveTo(b.x, b.y + b.h);
              ctx.lineTo(b.x, b.y + r);
              ctx.quadraticCurveTo(b.x, b.y, b.x + r, b.y);
              ctx.lineTo(b.x + b.w - r, b.y);
              ctx.quadraticCurveTo(b.x + b.w, b.y, b.x + b.w, b.y + r);
              ctx.lineTo(b.x + b.w, b.y + b.h);
              ctx.closePath();
              ctx.fill();

              // 2. Capuchon de crête flottant (Peak Drop)
              if (isPlaybackRunning && b.peakY < b.y - 1) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.fillRect(b.x, b.peakY, b.w, 2);
              }

              // 3. Reflet miroir au sol (atténué vers le bas)
              const reflH = Math.min(18, b.h * 0.22);
              if (reflH > 1) {
                const reflGrad = ctx.createLinearGradient(0, baselineY, 0, baselineY + reflH);
                reflGrad.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
                reflGrad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
                ctx.fillStyle = reflGrad;
                ctx.fillRect(b.x, baselineY + 1, b.w, reflH);
              }
            }
          } else {
            // MODE WAVE : Onde sinusoïdale liquide néon + étincelles
            const midY = height * 0.52;
            const waveAmp = (height * 0.26) * (0.3 + smoothedEnergy * 0.45 + smoothedPulse * 0.5) * profile.waveAmp;

            if (!isPlaybackRunning) {
              // Ligne de veille plate
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
              ctx.lineWidth = 1.8;
              ctx.beginPath();
              ctx.moveTo(width * 0.08, midY);
              ctx.lineTo(width * 0.92, midY);
              ctx.stroke();
            } else {
              // 1. Étincelles d'ambiance
              for (const s of sparks) {
                s.x += s.vx * (1 + smoothedPulse * 1.5);
                s.y += s.vy;
                if (s.x < 0) s.x = width;
                if (s.x > width) s.x = 0;
                if (s.y < height * 0.15) s.y = height * 0.85;
                if (s.y > height * 0.85) s.y = height * 0.15;

                const sparkAlpha = s.alpha * (0.4 + smoothedPulse * 0.6);
                ctx.fillStyle = `rgba(255, 255, 255, ${sparkAlpha.toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.size * (1 + smoothedPulse * 0.3), 0, Math.PI * 2);
                ctx.fill();
              }

              // 2. Onde secondaire douce (fond lumineux)
              ctx.beginPath();
              ctx.moveTo(0, midY);
              for (let x = 0; x <= width; x += 6) {
                const nx = x / width;
                const env = Math.sin(nx * Math.PI);
                const y = midY + Math.sin(nx * 7 - phase * 1.2) * (waveAmp * 0.55) * env;
                ctx.lineTo(x, y);
              }
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
              ctx.lineWidth = 2;
              ctx.stroke();

              // 3. Onde principale néon éclatante
              ctx.beginPath();
              ctx.moveTo(0, midY);
              for (let x = 0; x <= width; x += 4) {
                const nx = x / width;
                const env = Math.sin(nx * Math.PI);
                const y =
                  midY +
                  (Math.sin(nx * 8 + phase) * 0.65 + Math.cos(nx * 14 - phase * 1.4) * 0.35) *
                    waveAmp *
                    env;
                ctx.lineTo(x, y);
              }
              ctx.strokeStyle = '#FFFFFF';
              ctx.lineWidth = 2.8;
              ctx.shadowColor = '#FFFFFF';
              ctx.shadowBlur = 8;
              ctx.stroke();
              ctx.shadowBlur = 0;
            }
          }

          ctx.restore();
        }
      }

      // ──────────────────────────────────────────────────────────────────────
      // 3. RENDU MOBILE NATIF VIA setNativeProps (120 FPS ZÉRO LAG)
      // ──────────────────────────────────────────────────────────────────────
      if (Platform.OS !== 'web' && pathRef.current) {
        let pathD = '';

        if (currentMode === 'bars') {
          const r = barRadius;
          for (let i = 0; i < barsList.length; i++) {
            const b = barsList[i];
            const x0 = b.x.toFixed(1);
            const x1 = (b.x + b.w).toFixed(1);
            const yBottom = (b.y + b.h).toFixed(1);
            const yTop = b.y.toFixed(1);
            const yCorner = (b.y + r).toFixed(1);

            // Barre
            pathD += `M ${x0} ${yBottom} L ${x0} ${yCorner} Q ${x0} ${yTop} ${(b.x + r).toFixed(1)} ${yTop} L ${(b.x + b.w - r).toFixed(1)} ${yTop} Q ${x1} ${yTop} ${x1} ${yCorner} L ${x1} ${yBottom} Z `;

            // Pic de crête
            if (isPlaybackRunning && b.peakY < b.y - 1) {
              const py = b.peakY.toFixed(1);
              pathD += `M ${x0} ${py} L ${x1} ${py} L ${x1} ${(b.peakY + 2).toFixed(1)} L ${x0} ${(b.peakY + 2).toFixed(1)} Z `;
            }
          }
        } else {
          // Mode Wave courbe pour Native SVG
          const midY = height * 0.52;
          const waveAmp = (height * 0.26) * (0.3 + smoothedEnergy * 0.45 + smoothedPulse * 0.5) * profile.waveAmp;

          if (!isPlaybackRunning) {
            pathD = `M ${(width * 0.08).toFixed(1)} ${midY.toFixed(1)} L ${(width * 0.92).toFixed(1)} ${midY.toFixed(1)} `;
          } else {
            pathD = `M 0 ${midY.toFixed(1)} `;
            for (let x = 0; x <= width; x += 10) {
              const nx = x / width;
              const env = Math.sin(nx * Math.PI);
              const y =
                midY +
                (Math.sin(nx * 8 + phase) * 0.65 + Math.cos(nx * 14 - phase * 1.4) * 0.35) *
                  waveAmp *
                  env;
              pathD += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
            }
          }
        }

        if (pathRef.current.setNativeProps && pathD !== '') {
          pathRef.current.setNativeProps({ d: pathD });
        }
      }

      animId = requestAnimationFrame(render);
    };

    startLoop();

    const appStateSub =
      Platform.OS !== 'web'
        ? AppState.addEventListener('change', (state) => {
            if (state === 'active') {
              startLoop();
            } else {
              stopLoop();
            }
          })
        : null;

    return () => {
      cancelled = true;
      stopLoop();
      appStateSub?.remove();
    };
  }, [width, height]);

  return (
    <View
      style={[styles.container, { height }]}
      onLayout={(e) => {
        const { width: w } = e.nativeEvent.layout;
        if (w > 0 && Math.abs(w - layoutWidth) > 2) {
          setLayoutWidth(w);
        }
      }}
    >
      {Platform.OS === 'web' ? (
        <canvas
          ref={canvasRef}
          style={
            {
              width: '100%',
              height: '100%',
              display: 'block',
              pointerEvents: 'none',
              backgroundColor: 'transparent',
            } as any
          }
        />
      ) : (
        <Svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ backgroundColor: 'transparent' }}
        >
          <Path
            ref={pathRef}
            d="M 0 0"
            fill={mode === 'bars' ? '#FFFFFF' : 'none'}
            stroke={mode === 'wave' ? '#FFFFFF' : 'none'}
            strokeWidth={mode === 'wave' ? 2.5 : 0}
          />
        </Svg>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
});
