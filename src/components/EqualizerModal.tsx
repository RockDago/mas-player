import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  Switch,
} from 'react-native';
import Slider from '@react-native-community/slider';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { KnobControl } from './KnobControl';
import { DSPState, EqualizerPreset } from '../types/audio';
import { EQ_FREQUENCIES, DEFAULT_PRESETS } from '../constants/presets';

interface EqualizerModalProps {
  visible: boolean;
  onClose: () => void;
  dsp: DSPState;
  onUpdateDSP: (newDsp: DSPState) => void;
}

export const EqualizerModal: React.FC<EqualizerModalProps> = ({
  visible,
  onClose,
  dsp,
  onUpdateDSP,
}) => {
  const triggerHaptic = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // Ignored
    }
  };

  const handleToggle = (enabled: boolean) => {
    triggerHaptic();
    onUpdateDSP({ ...dsp, enabled });
  };

  const handleSelectPreset = (preset: EqualizerPreset) => {
    triggerHaptic();
    onUpdateDSP({
      ...dsp,
      presetId: preset.id,
      bass: dsp.bass,
      treble: dsp.treble,
      preamp: preset.preamp,
      bands: [...preset.bands],
    });
  };

  const handleBandChange = (index: number, val: number) => {
    const updatedBands = [...dsp.bands];
    updatedBands[index] = Math.round(val);
    onUpdateDSP({
      ...dsp,
      presetId: 'custom',
      bands: updatedBands,
    });
  };

  const handleBassChange = (val: number) => {
    // When adjusting bass knob, it also shifts the low frequency bands (31Hz, 62Hz, 125Hz)
    const updatedBands = [...dsp.bands];
    const diff = val - dsp.bass;
    updatedBands[0] = Math.max(-12, Math.min(12, updatedBands[0] + diff));
    updatedBands[1] = Math.max(-12, Math.min(12, updatedBands[1] + diff * 0.8));
    updatedBands[2] = Math.max(-12, Math.min(12, updatedBands[2] + diff * 0.5));

    onUpdateDSP({
      ...dsp,
      bass: val,
      presetId: 'custom',
      bands: updatedBands,
    });
  };

  const handleTrebleChange = (val: number) => {
    // When adjusting treble knob, it also shifts the high frequency bands (4kHz, 8kHz, 16kHz)
    const updatedBands = [...dsp.bands];
    const diff = val - dsp.treble;
    updatedBands[7] = Math.max(-12, Math.min(12, updatedBands[7] + diff * 0.5));
    updatedBands[8] = Math.max(-12, Math.min(12, updatedBands[8] + diff * 0.8));
    updatedBands[9] = Math.max(-12, Math.min(12, updatedBands[9] + diff));

    onUpdateDSP({
      ...dsp,
      treble: val,
      presetId: 'custom',
      bands: updatedBands,
    });
  };

  const handlePreampChange = (val: number) => {
    onUpdateDSP({
      ...dsp,
      preamp: val,
    });
  };

  const handleResetFlat = () => {
    triggerHaptic();
    const flat = DEFAULT_PRESETS.find((p) => p.id === 'flat')!;
    handleSelectPreset(flat);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container}>
        {/* Header Bar */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={onClose}
            style={styles.closeBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </TouchableOpacity>

          <View style={styles.titleContainer}>
            <Text style={styles.title}>ÉGALISEUR DSP</Text>
            <Text style={styles.subtitle}>MAS AUDIO ENGINE</Text>
          </View>

          <View style={styles.toggleRow}>
            <Text
              style={[
                styles.toggleLabel,
                { color: dsp.enabled ? '#FFFFFF' : '#64748B' },
              ]}
            >
              {dsp.enabled ? 'ACTIF' : 'BYPASS'}
            </Text>
            <Switch
              value={dsp.enabled}
              onValueChange={handleToggle}
              trackColor={{ false: '#1E232D', true: '#4C566A' }}
              thumbColor={dsp.enabled ? '#ECEFF4' : '#64748B'}
            />
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {/* Main Knobs Section: Bass, Preamp, Treble */}
          <View style={styles.knobsCard}>
            <Text style={styles.sectionTitle}>TONE & PREAMP</Text>
            <View style={styles.knobsRow}>
              <KnobControl
                label="BASS"
                value={dsp.bass}
                min={-12}
                max={12}
                accentColor="#81A1C1"
                onChange={handleBassChange}
              />

              <KnobControl
                label="PRÉ-AMPLI"
                value={dsp.preamp}
                min={-6}
                max={6}
                accentColor="#D8DEE9"
                onChange={handlePreampChange}
                size={76}
              />

              <KnobControl
                label="TREBLE"
                value={dsp.treble}
                min={-12}
                max={12}
                accentColor="#81A1C1"
                onChange={handleTrebleChange}
              />
            </View>
          </View>

          {/* Presets Horizontal Selector */}
          <View style={styles.presetsSection}>
            <View style={styles.presetsHeader}>
              <Text style={styles.sectionTitle}>PRÉRÉGLAGES (PRESETS)</Text>
              <TouchableOpacity onPress={handleResetFlat}>
                <Text style={styles.resetText}>Réinitialiser (Flat)</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.presetsScroll}
            >
              {DEFAULT_PRESETS.map((preset) => {
                const isSelected = dsp.presetId === preset.id;
                return (
                  <TouchableOpacity
                    key={preset.id}
                    onPress={() => handleSelectPreset(preset)}
                    style={[
                      styles.presetBadge,
                      isSelected && styles.presetBadgeSelected,
                    ]}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.presetBadgeText,
                        isSelected && styles.presetBadgeTextSelected,
                      ]}
                    >
                      {preset.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* 10-Band Graphic Equalizer Faders */}
          <View style={styles.equalizerCard}>
            <View style={styles.eqHeaderRow}>
              <Text style={styles.sectionTitle}>ÉGALISEUR 10 BANDES</Text>
              <Text style={styles.eqScale}>+12 dB / 0 dB / -12 dB</Text>
            </View>

            {/* Zero dB Center Baseline */}
            <View style={styles.zeroLine} />

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.eqSlidersContainer}
            >
              {EQ_FREQUENCIES.map((freq, index) => {
                const bandGain = dsp.bands[index] ?? 0;
                return (
                  <View key={freq} style={styles.sliderColumn}>
                    {/* Gain reading */}
                    <Text
                      style={[
                        styles.gainLabel,
                        {
                          color:
                            bandGain !== 0
                              ? '#ECEFF4'
                              : '#64748B',
                        },
                      ]}
                    >
                      {bandGain > 0 ? `+${bandGain}` : `${bandGain}`}
                    </Text>

                    {/* Vertical Slider Wrapper */}
                    <View style={styles.sliderWrapper}>
                      <Slider
                        style={styles.verticalSlider}
                        minimumValue={-12}
                        maximumValue={12}
                        step={1}
                        value={bandGain}
                        onValueChange={(val) => handleBandChange(index, val)}
                        minimumTrackTintColor="#81A1C1"
                        maximumTrackTintColor="#1E232D"
                        thumbTintColor="#ECEFF4"
                      />
                    </View>

                    {/* Frequency label */}
                    <Text style={styles.frequencyLabel}>{freq}</Text>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  closeBtn: {
    padding: 4,
  },
  titleContainer: {
    alignItems: 'center',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 2,
  },
  subtitle: {
    color: '#81A1C1',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.2,
    marginTop: 2,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toggleLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  sectionTitle: {
    color: '#81A1C1',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  knobsCard: {
    backgroundColor: '#0D0F14',
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#191C24',
  },
  knobsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    marginTop: 16,
  },
  presetsSection: {
    marginTop: 20,
    paddingHorizontal: 16,
  },
  presetsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  resetText: {
    color: '#ECEFF4',
    fontSize: 12,
    fontWeight: '600',
  },
  presetsScroll: {
    paddingRight: 16,
    gap: 8,
  },
  presetBadge: {
    backgroundColor: '#0D0F14',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E232D',
    marginRight: 8,
  },
  presetBadgeSelected: {
    backgroundColor: '#1E232D',
    borderColor: '#4C566A',
  },
  presetBadgeText: {
    color: '#81A1C1',
    fontSize: 12,
    fontWeight: '600',
  },
  presetBadgeTextSelected: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  equalizerCard: {
    backgroundColor: '#0D0F14',
    marginHorizontal: 16,
    marginTop: 20,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#191C24',
  },
  eqHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  eqScale: {
    color: '#475569',
    fontSize: 10,
    fontWeight: '700',
  },
  zeroLine: {
    position: 'absolute',
    top: '55%',
    left: 16,
    right: 16,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderStyle: 'dashed',
  },
  eqSlidersContainer: {
    paddingHorizontal: 4,
    gap: 12,
  },
  sliderColumn: {
    alignItems: 'center',
    width: 48,
  },
  gainLabel: {
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 8,
    fontVariant: ['tabular-nums'],
  },
  sliderWrapper: {
    height: 160,
    width: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  verticalSlider: {
    width: 140,
    height: 40,
    transform: [{ rotate: '-90deg' }],
  },
  frequencyLabel: {
    color: '#81A1C1',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 8,
  },
});
