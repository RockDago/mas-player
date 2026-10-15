import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Rect, Path, G } from 'react-native-svg';
import { LanguageCode } from '../i18n/translations';

interface CountryFlagProps {
  code: LanguageCode;
  width?: number;
  height?: number;
}

export const CountryFlag: React.FC<CountryFlagProps> = ({
  code,
  width = 27,
  height = 18,
}) => {
  const renderFlag = () => {
    switch (code) {
      case 'fr': // France (Bleu - Blanc - Rouge)
        return (
          <Svg width="100%" height="100%" viewBox="0 0 30 20">
            <Rect x="0" y="0" width="10" height="20" fill="#002395" />
            <Rect x="10" y="0" width="10" height="20" fill="#FFFFFF" />
            <Rect x="20" y="0" width="10" height="20" fill="#ED2939" />
          </Svg>
        );

      case 'en': // United Kingdom (Union Jack)
        return (
          <Svg width="100%" height="100%" viewBox="0 0 30 20">
            <Rect width="30" height="20" fill="#012169" />
            {/* Diagonales blanches */}
            <Path d="M0,0 L30,20 M30,0 L0,20" stroke="#FFFFFF" strokeWidth="4" />
            {/* Diagonales rouges */}
            <Path d="M0,0 L30,20 M30,0 L0,20" stroke="#C8102E" strokeWidth="2" />
            {/* Croix centrale blanche */}
            <Path d="M15,0 L15,20 M0,10 L30,10" stroke="#FFFFFF" strokeWidth="6" />
            {/* Croix centrale rouge */}
            <Path d="M15,0 L15,20 M0,10 L30,10" stroke="#C8102E" strokeWidth="3.6" />
          </Svg>
        );

      case 'es': // Espagne (Rouge - Jaune - Rouge)
        return (
          <Svg width="100%" height="100%" viewBox="0 0 30 20">
            <Rect x="0" y="0" width="30" height="5" fill="#AA151B" />
            <Rect x="0" y="5" width="30" height="10" fill="#F1BF00" />
            <Rect x="0" y="15" width="30" height="5" fill="#AA151B" />
            {/* Blason stylisé minimaliste */}
            <Rect x="6.5" y="8" width="4" height="4.5" rx="1" fill="#AA151B" />
            <Rect x="7.5" y="9" width="2" height="2.5" fill="#F1BF00" />
          </Svg>
        );

      case 'de': // Allemagne (Noir - Rouge - Or)
        return (
          <Svg width="100%" height="100%" viewBox="0 0 30 20">
            <Rect x="0" y="0" width="30" height="6.67" fill="#1C1917" />
            <Rect x="0" y="6.67" width="30" height="6.67" fill="#DD0000" />
            <Rect x="0" y="13.34" width="30" height="6.66" fill="#FFCE00" />
          </Svg>
        );

      case 'it': // Italie (Vert - Blanc - Rouge)
        return (
          <Svg width="100%" height="100%" viewBox="0 0 30 20">
            <Rect x="0" y="0" width="10" height="20" fill="#009246" />
            <Rect x="10" y="0" width="10" height="20" fill="#FFFFFF" />
            <Rect x="20" y="0" width="10" height="20" fill="#CE2B37" />
          </Svg>
        );

      default:
        return null;
    }
  };

  return (
    <View style={[styles.flagWrapper, { width, height }]}>
      {renderFlag()}
    </View>
  );
};

const styles = StyleSheet.create({
  flagWrapper: {
    borderRadius: 3.5,
    overflow: 'hidden',
    borderWidth: 0.8,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    backgroundColor: '#1E293B',
  },
});
