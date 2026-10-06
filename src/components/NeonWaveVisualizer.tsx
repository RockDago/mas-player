import React, { useEffect, useRef, useState, useMemo } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions, AppState } from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { beatStore } from '../services/beatStore';

interface NeonWaveVisualizerProps {
  height?: number;
  isActive?: boolean;
  hasTrack?: boolean;
  /**
   * Réactivité de l'onde aux basses.
   *
   * Le réglage s'appelait « spectre », mais `SpectrumVisualizer` n'est rendu
   * nulle part : le seul visualiseur monté est celui-ci, et il ne consomme
   * déjà que `beatStore.pulse`/`energy`. « Réactivité » est donc le seul mot
   * honnête — c'est la vitesse à laquelle l'onde suit le rythme, pas une
   * analyse fréquentielle.
   *
   * Lu par une ref dans la boucle RAF, pas par un `useState` : la boucle est
   * une `useEffect` qui ne dépend d'aucune prop, donc un changement ici ne
   * serait visible qu'au prochain remontage du composant — c'est-à-dire jamais
   * pendant que l'utilisateur regarde. Voir `spectrumRef`.
   */
  spectrumReactive?: 'low' | 'normal' | 'ultra';
}

/**
 * Coefficients de lissage : attaque, décroissance de la pulsation, et
 * réactivité de l'énergie.
 *
 * `normal` reproduit À L'IDENTIQUE les constantes qui étaient en dur dans la
 * boucle (0.7 / 0.22 / 0.16). Toute valeur différente ferait changer le rendu
 * par défaut alors que personne n'a touché à aucun réglage — un réglage par
 * défaut qui altère l'apparence de l'app est un bug, pas une améliore.
 */
const SPECTRUM_PROFILES = {
  low: { attack: 0.35, decay: 0.10, energy: 0.08, speedPulse: 1.4, speedEnergy: 0.5 },
  normal: { attack: 0.7, decay: 0.22, energy: 0.16, speedPulse: 2.2, speedEnergy: 0.8 },
  ultra: { attack: 0.92, decay: 0.45, energy: 0.34, speedPulse: 3.2, speedEnergy: 1.2 },
} as const;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  alpha: number;
  phase: number;
}

/**
 * NeonWaveVisualizer - Visualiseur d'ondes lumineuses néon haute performance (60 - 120 FPS).
 *
 * Spécifications demandées :
 * - Cadence native 60 à 120 FPS synchronisée sur l'écran (VSYNC sans bride artificielle).
 * - Suivi précis du rythme : les basses (kicks / transitoires graves) provoquent des jaillissements
 *   d'amplitude très marqués et visibles.
 * - Arrêt immédiat et aplatissement complet : quand la musique est coupée ou mise en pause,
 *   ou lorsqu'aucun morceau n'est chargé, l'onde est bloquée, plate et immobile.
 * - Reprise instantanée et bondissante dès la lecture.
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

  const isActiveRef = useRef(propIsActive);
  isActiveRef.current = propIsActive;
  const hasTrackRef = useRef(hasTrack);
  hasTrackRef.current = hasTrack;
  // Idem pour la réactivité : lue par la boucle RAF sans la reconstruire.
  const spectrumRef = useRef(spectrumReactive);
  spectrumRef.current = spectrumReactive;
  const spectrum = SPECTRUM_PROFILES[spectrumRef.current] ?? SPECTRUM_PROFILES.normal;

  const containerHeight = useMemo(() => {
    if (propHeight && propHeight > 0) return propHeight;
    const maxH = Math.round(windowHeight * 0.28);
    return Math.min(260, Math.max(150, maxH));
  }, [propHeight, windowHeight]);

  const [svgPaths, setSvgPaths] = useState<{
    cyanRibbon: string;
    magentaRibbon: string;
    violetRibbon: string;
    cyanGlow: string;
    magentaGlow: string;
    reflCyan: string;
    reflMagenta: string;
    pulseGlow: number;
    isFlat: boolean;
  }>({
    cyanRibbon: '',
    magentaRibbon: '',
    violetRibbon: '',
    cyanGlow: '',
    magentaGlow: '',
    reflCyan: '',
    reflMagenta: '',
    pulseGlow: 0,
    isFlat: true,
  });

  const width = layoutWidth > 0 ? layoutWidth : windowWidth || 360;
  const height = containerHeight;

  useEffect(() => {
    let animId: number | null = null;
    let cancelled = false;

    // Étincelles lumineuses
    const sparks: Spark[] = Array.from({ length: 22 }, () => ({
      x: Math.random() * width,
      y: height * 0.3 + Math.random() * (height * 0.35),
      vx: (Math.random() - 0.5) * 0.7,
      vy: (Math.random() - 0.5) * 0.3,
      size: 1.2 + Math.random() * 2.2,
      color: Math.random() > 0.45 ? '#00f0ff' : '#ec4899',
      alpha: 0.3 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
    }));

    let phase = 0;
    let smoothedPulse = 0;
    let smoothedEnergy = 0;
    let currentAmp = 0;
    let lastTime = performance.now();

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
      // Delta-time pour dynamique indépendante du framerate (60Hz, 90Hz, 120Hz)
      const rawDt = (time - lastTime) / 1000;
      const dt = Math.min(0.04, Math.max(0.005, rawDt));
      lastTime = time;

      const { pulse, energy } = beatStore.read();
      const isPlaybackRunning =
        hasTrackRef.current &&
        (isActiveRef.current !== undefined ? isActiveRef.current : beatStore.isPlaying) &&
        beatStore.isPlaying;

      // ── COMPORTEMENT EN PAUSE / ARRÊT / SANS MORCEAU ──────────────────────
      // Si pause ou aucun morceau : onde bloquée, plate et immobile.
      if (!isPlaybackRunning) {
        smoothedPulse = 0;
        smoothedEnergy = 0;
        currentAmp = 0;
        // Arrêt complet du défilement : phase reste figée
      } else {
        // En lecture : détection ultra-réactive des basses
        // Attaque instantanée sur le front montant du beat
        if (pulse > smoothedPulse) {
          // Attaque rapide sur le front montant du beat
          smoothedPulse += (pulse - smoothedPulse) * spectrum.attack;
        } else {
          // Décroissance douce
          smoothedPulse += (pulse - smoothedPulse) * spectrum.decay;
        }

        const targetEnergy = Math.max(0.25, energy);
        smoothedEnergy += (targetEnergy - smoothedEnergy) * spectrum.energy;

        // Vitesse d'ondulation influencée directement par le rythme
        const speedMult = 1.0 + smoothedPulse * spectrum.speedPulse + smoothedEnergy * spectrum.speedEnergy;
        phase += dt * 1.8 * speedMult;

        // Amplitude dynamique : les BASSES jaillissent de manière visible et percutante
        // Basses fortes : bondit jusqu'à 3x l'amplitude de base
        const bassSurge = Math.pow(smoothedPulse, 1.3) * 1.9;
        const targetAmp = (height * 0.22) * (0.35 + smoothedEnergy * 0.5 + bassSurge * 1.15);
        currentAmp += (targetAmp - currentAmp) * 0.35;
      }

      const baselineY = height * 0.45;
      const waterLineY = height * 0.70;
      const isCompletelyFlat = currentAmp <= 0.01;

      // ── RENDU CANVAS WEB (60 - 120 FPS NATIF) ──────────────────────────────
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

          if (isCompletelyFlat) {
            // LIGNE PARFAITEMENT PLATE AU REPOS : sobre, élégante, néon subtil
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';

            // Lueur cyan/magenta de veille sur la ligne plate
            ctx.beginPath();
            ctx.moveTo(displayWidth * 0.08, baselineY);
            ctx.lineTo(displayWidth * 0.92, baselineY);
            const flatGrad = ctx.createLinearGradient(0, 0, displayWidth, 0);
            flatGrad.addColorStop(0, 'rgba(0, 240, 255, 0)');
            flatGrad.addColorStop(0.3, 'rgba(0, 240, 255, 0.45)');
            flatGrad.addColorStop(0.5, 'rgba(236, 72, 153, 0.55)');
            flatGrad.addColorStop(0.7, 'rgba(56, 189, 248, 0.45)');
            flatGrad.addColorStop(1, 'rgba(0, 240, 255, 0)');

            ctx.strokeStyle = flatGrad;
            ctx.lineWidth = 1.8;
            ctx.shadowColor = '#00f0ff';
            ctx.shadowBlur = 8;
            ctx.stroke();
            ctx.restore();
          } else {
            // LECTURE ACTIVE : GRAND SPECTACLE LUMINEUX RÉACTIF AU SON
            // 1. Fond sombre & Auras d'ambiance
            const auraLeft = ctx.createRadialGradient(
              displayWidth * 0.18,
              displayHeight * 0.05,
              0,
              displayWidth * 0.18,
              displayHeight * 0.05,
              displayWidth * 0.35
            );
            auraLeft.addColorStop(0, `rgba(14, 116, 233, ${(0.12 + smoothedPulse * 0.15).toFixed(3)})`);
            auraLeft.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = auraLeft;
            ctx.fillRect(0, 0, displayWidth, displayHeight);

            const auraRight = ctx.createRadialGradient(
              displayWidth * 0.82,
              displayHeight * 0.08,
              0,
              displayWidth * 0.82,
              displayHeight * 0.08,
              displayWidth * 0.32
            );
            auraRight.addColorStop(0, `rgba(56, 189, 248, ${(0.10 + smoothedPulse * 0.12).toFixed(3)})`);
            auraRight.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = auraRight;
            ctx.fillRect(0, 0, displayWidth, displayHeight);

            // 2. Calcul des crêtes de vague
            const computeWave = (
              xNorm: number,
              timeOffset: number,
              freqBase: number,
              harmPhase: number
            ) => {
              const sin1 = Math.sin(xNorm * Math.PI * freqBase + phase + timeOffset);
              const sin2 = Math.sin(xNorm * Math.PI * (freqBase * 1.85) - harmPhase) * 0.38;
              const sin3 = Math.cos(xNorm * Math.PI * 0.9 + (phase + timeOffset) * 0.6) * 0.22;
              const taper = Math.sin(Math.pow(xNorm, 0.95) * Math.PI);
              return baselineY + (sin1 + sin2 + sin3) * currentAmp * taper;
            };

            const steps = Math.min(130, Math.max(64, Math.floor(displayWidth / 3.5)));
            const xStep = displayWidth / (steps - 1);

            // 3. Tracé des rubans néon multi-filaments
            const drawSilkRibbon = (
              timeOffset: number,
              freq: number,
              harmPhase: number,
              maxThickness: number,
              palette: { glowColor: string; c1: string; c2: string; c3: string },
              numFilaments: number,
              isForeground: boolean
            ) => {
              ctx.save();
              ctx.globalCompositeOperation = 'lighter';

              for (let s = 0; s < numFilaments; s++) {
                const strandFrac = s / (numFilaments - 1);
                const centerDist = Math.abs(strandFrac - 0.5) * 2;
                const strandAlpha = (0.2 + (1 - centerDist * 0.7) * 0.7) *
                  (0.55 + smoothedPulse * 0.55 + smoothedEnergy * 0.25);

                ctx.beginPath();
                for (let i = 0; i < steps; i++) {
                  const x = i * xStep;
                  const xNorm = i / (steps - 1);
                  const localThick = maxThickness * (0.3 + Math.sin(xNorm * Math.PI * freq * 1.4 + phase + timeOffset) * 0.7);
                  const spineY = computeWave(xNorm, timeOffset, freq, harmPhase);
                  const y = spineY + (strandFrac - 0.5) * localThick;

                  if (i === 0) ctx.moveTo(x, y);
                  else ctx.lineTo(x, y);
                }

                const grad = ctx.createLinearGradient(0, 0, displayWidth, 0);
                grad.addColorStop(0, palette.c1.replace('A', (strandAlpha * 0.2).toFixed(3)));
                grad.addColorStop(0.28, palette.c2.replace('A', strandAlpha.toFixed(3)));
                grad.addColorStop(0.72, palette.c3.replace('A', strandAlpha.toFixed(3)));
                grad.addColorStop(1, palette.c1.replace('A', (strandAlpha * 0.2).toFixed(3)));

                ctx.strokeStyle = grad;
                const isCenter = s === Math.floor(numFilaments / 2);
                ctx.lineWidth = isCenter ? (isForeground ? 2.5 : 1.9) : 1.05;

                if (isCenter) {
                  ctx.shadowColor = palette.glowColor;
                  // Les basses font briller intensément le cœur
                  ctx.shadowBlur = 14 + smoothedPulse * 24;
                } else {
                  ctx.shadowBlur = 0;
                }

                ctx.stroke();
              }

              ctx.restore();
            };

            // Ruban Violet Arrière-plan
            drawSilkRibbon(
              2.8,
              1.8,
              phase * 0.6,
              height * 0.16,
              {
                glowColor: '#8b5cf6',
                c1: 'rgba(139, 92, 246, A)',
                c2: 'rgba(99, 102, 241, A)',
                c3: 'rgba(192, 38, 211, A)',
              },
              8,
              false
            );

            // Ruban Magenta Médian
            drawSilkRibbon(
              1.4,
              2.1,
              phase * 0.85,
              height * 0.19,
              {
                glowColor: '#ec4899',
                c1: 'rgba(236, 72, 153, A)',
                c2: 'rgba(244, 63, 94, A)',
                c3: 'rgba(217, 70, 239, A)',
              },
              10,
              false
            );

            // Ruban Cyan Avant-plan (suit le rythme avec éclat)
            drawSilkRibbon(
              0,
              2.4,
              phase * 0.95,
              height * 0.22,
              {
                glowColor: '#00f0ff',
                c1: 'rgba(0, 240, 255, A)',
                c2: 'rgba(56, 189, 248, A)',
                c3: 'rgba(14, 165, 233, A)',
              },
              12,
              true
            );

            // 4. Reflets aquatiques miroir
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const reflAlpha = (0.35 + smoothedPulse * 0.45).toFixed(3);
            const reflGrad = ctx.createLinearGradient(0, waterLineY, 0, displayHeight);
            reflGrad.addColorStop(0, `rgba(0, 240, 255, ${reflAlpha})`);
            reflGrad.addColorStop(0.35, `rgba(236, 72, 153, ${(Number(reflAlpha) * 0.7).toFixed(3)})`);
            reflGrad.addColorStop(0.75, `rgba(139, 92, 246, ${(Number(reflAlpha) * 0.25).toFixed(3)})`);
            reflGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

            for (let r = 0; r < 4; r++) {
              ctx.beginPath();
              const rPhase = phase * 1.1 + r * 1.3;
              const rOffset = r * (displayHeight * 0.055);

              for (let i = 0; i < steps; i++) {
                const x = i * xStep;
                const xNorm = i / (steps - 1);
                const origWave = computeWave(xNorm, 0, 2.4, phase);
                const mirrorY = waterLineY + (waterLineY - origWave) * 0.36 + rOffset;
                const ripple = Math.sin(xNorm * 22 + rPhase) * (2.0 + smoothedPulse * 4.0);
                const y = Math.min(displayHeight - 1, mirrorY + ripple);

                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
              }

              ctx.strokeStyle = reflGrad;
              ctx.lineWidth = 1.3;
              ctx.stroke();
            }
            ctx.restore();

            // 5. Étincelles réactives
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            sparks.forEach((p) => {
              p.x += p.vx * (1 + smoothedPulse * 2);
              p.y += p.vy * (1 + smoothedPulse * 2);
              p.phase += 0.05;

              if (p.x < 0) p.x = displayWidth;
              if (p.x > displayWidth) p.x = 0;
              if (p.y < height * 0.12) p.y = height * 0.65;
              if (p.y > height * 0.72) p.y = height * 0.18;

              const curAlpha = Math.min(1, p.alpha + smoothedPulse * 0.7);
              const curSize = p.size * (1 + smoothedPulse * 0.7);

              ctx.beginPath();
              ctx.arc(p.x, p.y, curSize, 0, Math.PI * 2);
              ctx.fillStyle = p.color === '#00f0ff'
                ? `rgba(0, 240, 255, ${curAlpha})`
                : `rgba(236, 72, 153, ${curAlpha})`;
              ctx.shadowColor = p.color;
              ctx.shadowBlur = 8 + smoothedPulse * 12;
              ctx.fill();
            });
            ctx.restore();
          }

          ctx.restore();
        }
      }

      // ── RENDU MOBILE NATIF SVG (60 - 120 FPS FLUIDE) ──────────────────────
      if (Platform.OS !== 'web') {
        const steps = 38;
        const xStep = width / (steps - 1);

        if (isCompletelyFlat) {
          const flatD = `M 0 ${baselineY.toFixed(1)} L ${width.toFixed(1)} ${baselineY.toFixed(1)}`;
          setSvgPaths({
            cyanRibbon: '',
            magentaRibbon: '',
            violetRibbon: flatD,
            cyanGlow: flatD,
            magentaGlow: '',
            reflCyan: '',
            reflMagenta: '',
            pulseGlow: 0.2,
            isFlat: true,
          });
        } else {
          const buildPath = (offset: number, freq: number, hPhase: number) => {
            let d = '';
            for (let i = 0; i < steps; i++) {
              const x = i * xStep;
              const xNorm = i / (steps - 1);
              const w1 = Math.sin(xNorm * Math.PI * freq + phase + offset);
              const w2 = Math.sin(xNorm * Math.PI * (freq * 1.8) - hPhase) * 0.35;
              const taper = Math.sin(Math.pow(xNorm, 0.95) * Math.PI);
              const y = baselineY + (w1 + w2) * currentAmp * taper;

              if (i === 0) d += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
              else d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
            }
            return d;
          };

          const buildRibbonArea = (offset: number, freq: number, hPhase: number, thick: number) => {
            let topPoints: string[] = [];
            let botPoints: string[] = [];

            for (let i = 0; i < steps; i++) {
              const x = i * xStep;
              const xNorm = i / (steps - 1);
              const w1 = Math.sin(xNorm * Math.PI * freq + phase + offset);
              const w2 = Math.sin(xNorm * Math.PI * (freq * 1.8) - hPhase) * 0.35;
              const taper = Math.sin(Math.pow(xNorm, 0.95) * Math.PI);
              const centerY = baselineY + (w1 + w2) * currentAmp * taper;
              const t = thick * (0.35 + Math.sin(xNorm * Math.PI * freq + phase + offset) * 0.65);

              const yTop = centerY - t * 0.5;
              const yBot = centerY + t * 0.5;

              topPoints.push(`${x.toFixed(1)} ${yTop.toFixed(1)}`);
              botPoints.unshift(`${x.toFixed(1)} ${yBot.toFixed(1)}`);
            }

            return `M ${topPoints.join(' L ')} L ${botPoints.join(' L ')} Z`;
          };

          const buildReflectionPath = (offset: number, freq: number) => {
            let d = '';
            for (let i = 0; i < steps; i++) {
              const x = i * xStep;
              const xNorm = i / (steps - 1);
              const w1 = Math.sin(xNorm * Math.PI * freq + phase + offset);
              const taper = Math.sin(Math.pow(xNorm, 0.95) * Math.PI);
              const origY = baselineY + w1 * (currentAmp * 0.4) * taper;
              const y = waterLineY + (waterLineY - origY) * 0.35 + Math.sin(xNorm * 16 + phase) * 2.5;
              if (i === 0) d += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
              else d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
            }
            return d;
          };

          setSvgPaths({
            cyanRibbon: buildRibbonArea(0, 2.4, phase * 0.9, height * 0.20),
            magentaRibbon: buildRibbonArea(1.4, 2.1, phase * 0.8, height * 0.18),
            violetRibbon: buildPath(2.8, 1.8, phase * 0.6),
            cyanGlow: buildPath(0, 2.4, phase * 0.9),
            magentaGlow: buildPath(1.4, 2.1, phase * 0.8),
            reflCyan: buildReflectionPath(0, 2.4),
            reflMagenta: buildReflectionPath(1.4, 2.1),
            pulseGlow: Math.min(1, 0.35 + smoothedPulse * 0.75),
            isFlat: false,
          });
        }
      }

      animId = requestAnimationFrame(render);
    };

    startLoop();

    const appStateSub = Platform.OS !== 'web'
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
            } as any
          }
        />
      ) : (
        <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <Defs>
            <LinearGradient id="cyanGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <Stop offset="0%" stopColor="#00f0ff" stopOpacity="0.2" />
              <Stop offset="35%" stopColor="#00f0ff" stopOpacity="0.95" />
              <Stop offset="70%" stopColor="#38bdf8" stopOpacity="0.9" />
              <Stop offset="100%" stopColor="#0284c7" stopOpacity="0.2" />
            </LinearGradient>

            <LinearGradient id="magentaGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <Stop offset="0%" stopColor="#ec4899" stopOpacity="0.2" />
              <Stop offset="50%" stopColor="#f43f5e" stopOpacity="0.95" />
              <Stop offset="80%" stopColor="#d946ef" stopOpacity="0.85" />
              <Stop offset="100%" stopColor="#a855f7" stopOpacity="0.2" />
            </LinearGradient>

            <LinearGradient id="violetGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <Stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.1" />
              <Stop offset="50%" stopColor="#a855f7" stopOpacity="0.8" />
              <Stop offset="100%" stopColor="#6366f1" stopOpacity="0.1" />
            </LinearGradient>

            <LinearGradient id="cyanFillGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <Stop offset="0%" stopColor="#00f0ff" stopOpacity="0.05" />
              <Stop offset="45%" stopColor="#00f0ff" stopOpacity="0.32" />
              <Stop offset="100%" stopColor="#38bdf8" stopOpacity="0.05" />
            </LinearGradient>

            <LinearGradient id="magentaFillGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <Stop offset="0%" stopColor="#f43f5e" stopOpacity="0.05" />
              <Stop offset="50%" stopColor="#ec4899" stopOpacity="0.28" />
              <Stop offset="100%" stopColor="#d946ef" stopOpacity="0.05" />
            </LinearGradient>

            <LinearGradient id="reflGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="0%" stopColor="#00f0ff" stopOpacity="0.45" />
              <Stop offset="50%" stopColor="#ec4899" stopOpacity="0.22" />
              <Stop offset="100%" stopColor="#000000" stopOpacity="0.0" />
            </LinearGradient>
          </Defs>

          <Rect x={0} y={0} width={width} height={height} fill="transparent" />

          {/* Mode plat si musique arrêtée */}
          {svgPaths.isFlat ? (
            <Path
              d={svgPaths.cyanGlow}
              stroke="url(#cyanGrad)"
              strokeWidth={2}
              fill="none"
              opacity={0.7}
            />
          ) : (
            <>
              {svgPaths.violetRibbon ? (
                <Path
                  d={svgPaths.violetRibbon}
                  stroke="url(#violetGrad)"
                  strokeWidth={2}
                  fill="none"
                  opacity={0.65}
                />
              ) : null}

              {svgPaths.magentaRibbon ? (
                <Path
                  d={svgPaths.magentaRibbon}
                  fill="url(#magentaFillGrad)"
                  stroke="none"
                />
              ) : null}
              {svgPaths.magentaGlow ? (
                <>
                  <Path
                    d={svgPaths.magentaGlow}
                    stroke="#f43f5e"
                    strokeWidth={5}
                    fill="none"
                    opacity={0.3 * svgPaths.pulseGlow}
                  />
                  <Path
                    d={svgPaths.magentaGlow}
                    stroke="url(#magentaGrad)"
                    strokeWidth={2.2}
                    fill="none"
                    opacity={0.95}
                  />
                </>
              ) : null}

              {svgPaths.cyanRibbon ? (
                <Path
                  d={svgPaths.cyanRibbon}
                  fill="url(#cyanFillGrad)"
                  stroke="none"
                />
              ) : null}
              {svgPaths.cyanGlow ? (
                <>
                  <Path
                    d={svgPaths.cyanGlow}
                    stroke="#00f0ff"
                    strokeWidth={6}
                    fill="none"
                    opacity={0.4 * svgPaths.pulseGlow}
                  />
                  <Path
                    d={svgPaths.cyanGlow}
                    stroke="url(#cyanGrad)"
                    strokeWidth={2.5}
                    fill="none"
                    opacity={1}
                  />
                </>
              ) : null}

              {svgPaths.reflCyan ? (
                <Path
                  d={svgPaths.reflCyan}
                  stroke="url(#reflGrad)"
                  strokeWidth={1.8}
                  fill="none"
                  opacity={0.6 * svgPaths.pulseGlow}
                />
              ) : null}
              {svgPaths.reflMagenta ? (
                <Path
                  d={svgPaths.reflMagenta}
                  stroke="url(#reflGrad)"
                  strokeWidth={1.4}
                  fill="none"
                  opacity={0.45 * svgPaths.pulseGlow}
                />
              ) : null}
            </>
          )}
        </Svg>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000000',
    position: 'relative',
    overflow: 'hidden',
  },
});
