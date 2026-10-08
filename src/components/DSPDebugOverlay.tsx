import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getNativeDSPDiagnostics } from '../services/nativeAudioDSP';
import { playerManager } from '../services/playerManager';

const TOGGLE_KEY = 'mas_player_dsp_debug_overlay_v1';

/** Verdict affiché en tête : la réponse à « l'EQ fonctionne-t-il ? ». */
type Verdict = { text: string; tone: 'ok' | 'ko' };

export function DSPDebugOverlay() {
  const [visible, setVisible] = useState(false);
  const [unlocked, setUnlocked] = useState(__DEV__);
  const [, force] = useState(0);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);

  // En build release `__DEV__` vaut `false` : l'overlay doit rester atteignable
  // sur l'APK/IPA installé, sinon le diagnostic est inaccessible exactement là
  // où il sert. Le drapeau est donc persisté, et s'active par cinq tapes sur le
  // bouton.
  useEffect(() => {
    AsyncStorage.getItem(TOGGLE_KEY)
      .then((v) => v === '1' && setUnlocked(true))
      .catch(() => {});
  }, []);

  const taps = useRef(0);
  const onToggle = useCallback(() => {
    if (!unlocked) {
      taps.current += 1;
      if (taps.current >= 5) {
        taps.current = 0;
        setUnlocked(true);
        AsyncStorage.setItem(TOGGLE_KEY, '1').catch(() => {});
      }
      return;
    }
    setVisible((v) => !v);
  }, [unlocked]);

  useEffect(() => {
    if (!visible) return;
    interval.current = setInterval(() => force((n) => n + 1), 500);
    return () => {
      if (interval.current) clearInterval(interval.current);
    };
  }, [visible]);

  if (!unlocked) return null;

  const diag = getNativeDSPDiagnostics();
  const nativeActive = playerManager.isNativeEngineActive();
  const sessionId = playerManager.getActiveAndroidSessionId();
  const pending = playerManager.getPendingDsp();

  const verdict: Verdict = (() => {
    if (!diag.moduleFound) {
      return { text: 'INACTIF — module natif absent (Expo Go ?)', tone: 'ko' };
    }
    if (diag.lastError) {
      return { text: 'ERREUR — setDSPAsync a échoué', tone: 'ko' };
    }
    if (Platform.OS === 'ios' && !nativeActive) {
      return {
        text: 'INACTIF — le son ne passe pas par le moteur natif (repli expo-audio)',
        tone: 'ko',
      };
    }
    if (Platform.OS === 'android' && sessionId === 0) {
      return { text: 'INACTIF — session audio Android non établie', tone: 'ko' };
    }
    if (diag.callCount === 0) {
      return { text: 'INACTIF — setDSPAsync n’a jamais été appelé', tone: 'ko' };
    }
    const age = diag.lastSuccessAgeMs;
    return {
      text:
        age === null
          ? 'EN COURS — premier appel en vol'
          : `ACTIF — dernier envoi il y a ${Math.round(age / 100) / 10} s`,
      tone: 'ok',
    };
  })();

  const verdictColor = verdict.tone === 'ok' ? '#4ADE80' : '#F87171';

  const rows: Array<[string, string]> = [
    ['plateforme', Platform.OS],
    ['module trouvé', diag.moduleFound ? 'oui' : 'NON'],
    ['moteur natif actif', nativeActive ? 'oui' : 'non'],
    ['session Android', String(sessionId)],
    ['appels setDSPAsync', String(diag.callCount)],
    ['dsp.pending présent', pending ? 'oui' : 'non'],
    [
      'bands envoyées',
      diag.lastPayload ? diag.lastPayload.bands.join(',') : '—',
    ],
    [
      'preamp envoyé',
      diag.lastPayload ? `${diag.lastPayload.preamp.toFixed(2)} dB` : '—',
    ],
    ['enabled envoyé', diag.lastPayload ? String(diag.lastPayload.enabled) : '—'],
    ['dernière erreur', diag.lastError ?? '—'],
    ['méthodes natives', diag.methods.join(' ') || '—'],
  ];

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {visible && (
        <View style={styles.panel}>
          <View style={[styles.verdict, { borderColor: verdictColor }]}>
            <Text style={[styles.verdictText, { color: verdictColor }]}>
              EQ {verdict.text}
            </Text>
          </View>
          <ScrollView style={styles.scroll} nestedScrollEnabled>
            {rows.map(([label, value]) => (
              <View key={label} style={styles.row}>
                <Text style={styles.key}>{label}</Text>
                <Text style={styles.val} numberOfLines={3}>
                  {value}
                </Text>
              </View>
            ))}
            <Pressable onPress={onToggle} style={styles.close}>
              <Text style={styles.closeText}>fermer</Text>
            </Pressable>
          </ScrollView>
        </View>
      )}
      <Pressable
        onPress={onToggle}
        style={styles.toggle}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={styles.toggleText}>EQ</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 10,
    bottom: 92,
    alignItems: 'flex-end',
  },
  toggle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  toggleText: {
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: '700',
  },
  panel: {
    width: 320,
    maxHeight: 400,
    marginBottom: 8,
    backgroundColor: 'rgba(10,12,16,0.95)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    padding: 10,
  },
  verdict: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginBottom: 8,
  },
  verdictText: {
    fontSize: 11,
    fontWeight: '700',
  },
  scroll: {
    maxHeight: 320,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  key: {
    color: '#6B7280',
    fontSize: 10,
    width: 128,
  },
  val: {
    color: '#E5E7EB',
    fontSize: 10,
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  close: {
    marginTop: 10,
    alignSelf: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  closeText: {
    color: '#D1D5DB',
    fontSize: 10,
  },
});

export default DSPDebugOverlay;