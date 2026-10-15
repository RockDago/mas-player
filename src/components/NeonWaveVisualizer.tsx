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
   * Réactivité du visualiseur aux basses.
   */
  spectrumReactive?: 'low' | 'normal' | 'ultra';
}

const SPECTRUM_PROFILES = {
  low: { attack: 0.65, decay: 0.14, bounce: 0.85 },
  normal: { attack: 0.78, decay: 0.17, bounce: 1.0 },
  ultra: { attack: 0.92, decay: 0.22, bounce: 1.2 },
} as const;

// Pré-calcul de variations naturelles entre barres pour reproduire le relief de l'image
const MAX_BARS = 80;
const BAR_SEEDS: number[] = [];
for (let i = 0; i < MAX_BARS; i++) {
  const n = Math.sin((i + 5) * 47.19) * 43758.5453;
  const rand = n - Math.floor(n);
  BAR_SEEDS.push(0.85 + rand * 0.30);
}

/**
 * NeonWaveVisualizer - Spectre audio haute précision 120 FPS :
 * - Équilibré ("balance") sans jamais plafonner ou saturer en haut.
 * - Synchronisation en temps réel :
 *     * Gauche (0..28%) : Basses profondes & kicks de batterie
 *     * Centre (32..68%) : Voix du chanteur & instruments mélodiques
 *     * Droite (70..100%) : Aigus & percussions légères
 * - Relief dynamique identique à l'image de référence avec creux et bosses musicales.
 * - Fluidité 120 FPS sans re-render React (Canvas sur Web, setNativeProps sur Native).
 * - Barres blanches (`#FFFFFF`), fond noir et transparent.
 */
export const NeonWaveVisualizer: React.FC<NeonWaveVisualizerProps> = ({
  height: propHeight,
  isActive: propIsActive,
  hasTrack = true,
  spectrumReactive = 'normal',
}) => {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [layoutWidth, setLayoutWidth] = useState<number>(windowWidth || 360);
  const canvasRef = useRef<any>(null);
  const pathRef = useRef<any>(null);

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

    // Tableaux de hauteurs courantes lissées pour l'effet de rebond et de gravité
    const currentHeights = new Float32Array(MAX_BARS);

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

        // Ondulation douce pour les harmoniques
        phase += dt * (1.8 + smoothedPulse * 2.0);
      }

      // Configuration dynamique de la grille de barres
      const horizontalPadding = 12;
      const availableWidth = width - horizontalPadding * 2;
      const barGap = Math.max(2, Math.round(width * 0.0055));
      const targetBarWidth = Math.max(3, Math.min(5, Math.round(width * 0.0105)));
      const slot = targetBarWidth + barGap;
      const numBars = Math.max(28, Math.min(MAX_BARS, Math.floor(availableWidth / slot)));

      const totalBarsWidth = numBars * slot - barGap;
      const startX = (width - totalBarsWidth) / 2;

      // Hauteur équilibrée avec marge d'aération en haut pour éviter toute coupure
      const baselineY = height - 6;
      const maxBarHeight = height - 12;
      const barRadius = Math.min(2.2, targetBarWidth / 2);

      const barsList: Array<{ x: number; y: number; w: number; h: number }> = [];

      for (let i = 0; i < numBars; i++) {
        const normX = i / (numBars - 1); // 0 (basses gauches) -> 1 (aigus droits)

        let targetNorm = 0;

        if (isPlaybackRunning) {
          if (hasLiveAudio) {
            // ── 1. MODE TEMPS RÉEL SUR LE FLUX AUDIO (PCM / ÉGALISEUR) ───────
            // A. Basses & Kicks (à gauche 0..28%)
            const bassDist = normX / 0.30;
            const bassEnvelope = Math.max(0, 1 - Math.pow(Math.min(1, bassDist), 1.3));
            const bassPart = bassEnvelope * (0.20 + specData.bass * 0.50 + smoothedPulse * 0.22);

            // B. Voix & Instruments mélodiques (au centre 32..68%)
            // Cible précisément les fréquences vocales (~300 Hz - 3.5 kHz)
            const vocalDist = Math.abs(normX - 0.54) / 0.22;
            const vocalEnvelope = Math.max(0, 1 - Math.pow(Math.min(1, vocalDist), 1.4));
            const vocalPart = vocalEnvelope * (0.16 + specData.vocal * 0.46 + smoothedEnergy * 0.16);

            // C. Aigus & Cymbales (à droite 70..100%)
            const trebleEnvelope = Math.max(0, (1 - normX) / 0.35);
            const treblePart = Math.pow(trebleEnvelope, 1.2) * (0.06 + specData.treble * 0.36);

            // D. Bacs spectraux directs
            const binIdx = Math.min(specData.bins.length - 1, Math.floor(normX * specData.bins.length));
            const binPart = specData.bins[binIdx] * 0.32;

            const combined =
              (bassPart + vocalPart + treblePart + binPart) *
              BAR_SEEDS[i % BAR_SEEDS.length] *
              profile.bounce;

            // Plage de hauteur parfaitement équilibrée (pics à 0.82 max, pas de saturation plate)
            targetNorm = Math.min(0.84, Math.max(0.03, combined * 0.78));
          } else {
            // ── 2. MODE SIMULATION HARMONIQUE DE REPLI ────────────────────────
            // Profil spectral identique à l'image de référence :
            // Bosse de basse à gauche
            const bassEnv = Math.max(0, 1 - normX * 3.0);
            const bassHeight = Math.pow(bassEnv, 1.2) * (0.35 + smoothedPulse * 0.45);

            // Creux bas-médiums puis bosse vocale au centre
            const midDist = Math.abs(normX - 0.56);
            const midEnv = Math.max(0, 1 - midDist * 3.4);
            const midHeight = Math.pow(midEnv, 1.3) * (0.28 + smoothedEnergy * 0.38);

            // Retombée douce vers les aigus à droite
            const rollOff = Math.max(0.05, 1 - Math.pow(normX, 1.8));

            // Ondulation musicale vivante
            const osc = Math.sin(normX * 9 + phase) * 0.12 + Math.cos(normX * 18 - phase * 1.5) * 0.08;
            const synth = (bassHeight + midHeight + 0.10 + osc) * rollOff;

            targetNorm = Math.min(
              0.82,
              Math.max(0.03, synth * BAR_SEEDS[i % BAR_SEEDS.length] * profile.bounce)
            );
          }
        } else {
          // Mode pause / arrêt : barres au repos minimal et calmes
          targetNorm = 0.02;
        }

        // Lissage avec attaque instantanée et retombée fluide (« balance » avec gravité)
        if (targetNorm > currentHeights[i]) {
          currentHeights[i] += (targetNorm - currentHeights[i]) * profile.attack;
        } else {
          currentHeights[i] += (targetNorm - currentHeights[i]) * profile.decay;
        }

        const barH = Math.max(3, currentHeights[i] * maxBarHeight);
        const barX = startX + i * slot;
        const barY = baselineY - barH;

        barsList.push({
          x: barX,
          y: barY,
          w: targetBarWidth,
          h: barH,
        });
      }

      // ── RENDU CANVAS WEB 120 FPS ULTRA-FLUIDE ─────────────────────────────
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

          ctx.fillStyle = '#FFFFFF';

          for (let i = 0; i < barsList.length; i++) {
            const b = barsList[i];
            const r = barRadius;

            ctx.beginPath();
            ctx.moveTo(b.x, b.y + b.h);
            ctx.lineTo(b.x, b.y + r);
            ctx.quadraticCurveTo(b.x, b.y, b.x + r, b.y);
            ctx.lineTo(b.x + b.w - r, b.y);
            ctx.quadraticCurveTo(b.x + b.w, b.y, b.x + b.w, b.y + r);
            ctx.lineTo(b.x + b.w, b.y + b.h);
            ctx.closePath();
            ctx.fill();
          }

          ctx.restore();
        }
      }

      // ── RENDU MOBILE NATIF 120 FPS VIA setNativeProps (ZÉRO LAG REACT) ────
      if (Platform.OS !== 'web' && pathRef.current && barsList.length > 0) {
        let pathD = '';
        const r = barRadius;

        for (let i = 0; i < barsList.length; i++) {
          const b = barsList[i];
          const x0 = b.x.toFixed(1);
          const x1 = (b.x + b.w).toFixed(1);
          const yBottom = (b.y + b.h).toFixed(1);
          const yTop = b.y.toFixed(1);
          const yCorner = (b.y + r).toFixed(1);

          pathD += `M ${x0} ${yBottom} L ${x0} ${yCorner} Q ${x0} ${yTop} ${(b.x + r).toFixed(1)} ${yTop} L ${(b.x + b.w - r).toFixed(1)} ${yTop} Q ${x1} ${yTop} ${x1} ${yCorner} L ${x1} ${yBottom} Z `;
        }

        if (pathRef.current.setNativeProps) {
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
          <Path ref={pathRef} d="M 0 0" fill="#FFFFFF" />
        </Svg>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: '100%',
    justifyContent: 'flex-end',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
});
