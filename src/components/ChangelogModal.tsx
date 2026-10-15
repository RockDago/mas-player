import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useScreenInsets, insetPadding } from '../theme/insets';
import { CHANGELOG_DATA, ChangelogRelease, ChangelogItem, ChangelogSubItem } from '../constants/changelog';
import { LanguageCode } from '../i18n/translations';

interface ChangelogModalProps {
  visible: boolean;
  onClose: () => void;
  language?: LanguageCode;
}

export const ChangelogModal: React.FC<ChangelogModalProps> = ({
  visible,
  onClose,
  language = 'fr',
}) => {
  const insets = useScreenInsets();
  // Permet de basculer entre français et anglais si l'utilisateur souhaite comparer
  const defaultLangKey = language === 'fr' ? 'fr' : 'en';
  const [activeLang, setActiveLang] = useState<'fr' | 'en'>(defaultLangKey);

  const releases: ChangelogRelease[] = CHANGELOG_DATA[activeLang] || CHANGELOG_DATA.fr;

  const handleClose = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    onClose();
  };

  const toggleLanguage = () => {
    try {
      Haptics.selectionAsync();
    } catch {}
    setActiveLang((prev) => (prev === 'fr' ? 'en' : 'fr'));
  };

  const renderSubItem = (sub: ChangelogSubItem, index: number) => {
    return (
      <View key={`sub-${index}`} style={styles.subItemRow}>
        <Text style={styles.bulletSymbol}>•</Text>
        <Text style={styles.subItemText}>
          {sub.boldTitle && (
            <Text
              style={[
                styles.boldText,
                sub.underlined && styles.underlinedText,
              ]}
            >
              {sub.boldTitle}{' '}
            </Text>
          )}
          <Text style={styles.bodyText}>{sub.text}</Text>
        </Text>
      </View>
    );
  };

  const renderItem = (item: ChangelogItem, index: number) => {
    return (
      <View key={`item-${index}`} style={styles.itemContainer}>
        <View style={styles.itemRow}>
          <Text style={styles.bulletSymbol}>•</Text>
          <Text style={styles.itemText}>
            {item.isCheck && (
              <Text style={styles.checkText}>✓ </Text>
            )}
            {item.boldTitle && (
              <Text
                style={[
                  styles.boldText,
                  item.underlinedTitle && styles.underlinedText,
                ]}
              >
                {item.boldTitle}{' '}
              </Text>
            )}
            <Text style={styles.bodyText}>{item.text}</Text>
          </Text>
        </View>

        {item.subItems && item.subItems.length > 0 && (
          <View style={styles.subItemsList}>
            {item.subItems.map((sub, sIdx) => renderSubItem(sub, sIdx))}
          </View>
        )}
      </View>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent={true}
      onRequestClose={handleClose}
    >
      <StatusBar style="light" />
      <View style={styles.overlay}>
        {/* Backdrop pour fermer au toucher en dehors */}
        <TouchableOpacity
          style={styles.backdropTouch}
          activeOpacity={1}
          onPress={handleClose}
        />

        {/* Boîte de dialogue Changelog - ancrée en bas, affichage du bas vers le haut */}
        <View
          style={[
            styles.dialogBox,
            {
              paddingBottom: insetPadding(insets, 'bottom', 18),
            },
          ]}
        >
          {/* Poignée indicatrice de glissement */}
          <View style={styles.dragHandleBar} />

          {/* En-tête */}
          <View style={styles.headerRow}>
            <Text style={styles.titleText}>Changelog</Text>

            {/* Sélecteur FR / EN discret */}
            <TouchableOpacity
              style={styles.langToggleBtn}
              onPress={toggleLanguage}
              activeOpacity={0.7}
            >
              <Text style={[styles.langToggleText, activeLang === 'fr' && styles.langActiveText]}>
                FR
              </Text>
              <Text style={styles.langDivider}>/</Text>
              <Text style={[styles.langToggleText, activeLang === 'en' && styles.langActiveText]}>
                EN
              </Text>
            </TouchableOpacity>
          </View>

          {/* Contenu défilant */}
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={true}
            indicatorStyle="white"
          >
            {releases.map((rel, rIdx) => (
              <View key={`release-${rIdx}`} style={styles.releaseBlock}>
                {/* Numéro de build */}
                <View style={styles.buildTitleRow}>
                  <Text style={styles.buildTitleText}>{rel.buildRange}:</Text>
                  {rel.date && (
                    <Text style={styles.buildDateText}>{rel.date}</Text>
                  )}
                </View>

                {/* Sections de la version */}
                {rel.sections.map((section, sIdx) => (
                  <View key={`sec-${sIdx}`} style={styles.sectionBlock}>
                    <View style={styles.sectionHeaderRow}>
                      <Text style={styles.bulletSymbol}>•</Text>
                      <Text style={styles.sectionHeaderText}>
                        {section.header}
                      </Text>
                    </View>

                    <View style={styles.itemsList}>
                      {section.items.map((item, iIdx) => renderItem(item, iIdx))}
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>

          {/* Pied avec bouton OK arrondi à droite */}
          <View style={styles.footerRow}>
            <TouchableOpacity
              style={styles.okButton}
              onPress={handleClose}
              activeOpacity={0.75}
            >
              <Text style={styles.okButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  backdropTouch: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  dragHandleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
    alignSelf: 'center',
    marginBottom: 12,
  },
  dialogBox: {
    width: '100%',
    maxWidth: 600,
    maxHeight: '88%',
    backgroundColor: '#16171C',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 22,
    paddingTop: 14,
    ...Platform.select({
      ios: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.5,
        shadowRadius: 20,
      },
      android: {
        elevation: 16,
      },
      web: {
        boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
      },
    }),
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  titleText: {
    fontSize: 24,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.3,
  },
  langToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 4,
  },
  langToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#71717A',
  },
  langActiveText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  langDivider: {
    fontSize: 11,
    color: '#52525B',
  },
  scrollArea: {
    flexGrow: 1,
  },
  scrollContent: {
    paddingBottom: 12,
  },
  releaseBlock: {
    marginBottom: 20,
  },
  buildTitleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  buildTitleText: {
    fontSize: 16.5,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  buildDateText: {
    fontSize: 12,
    color: '#71717A',
    fontWeight: '500',
  },
  sectionBlock: {
    marginBottom: 10,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  bulletSymbol: {
    fontSize: 15,
    lineHeight: 21,
    color: '#FFFFFF',
    marginRight: 8,
    fontWeight: '700',
  },
  sectionHeaderText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  itemsList: {
    paddingLeft: 10,
  },
  itemContainer: {
    marginBottom: 6,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  itemText: {
    flex: 1,
    fontSize: 13.5,
    lineHeight: 19.5,
    color: '#D4D4D8',
  },
  checkText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  boldText: {
    fontWeight: '700',
    color: '#FFFFFF',
  },
  underlinedText: {
    textDecorationLine: 'underline',
  },
  bodyText: {
    color: '#E4E4E7',
  },
  subItemsList: {
    paddingLeft: 18,
    marginTop: 4,
  },
  subItemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  subItemText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18.5,
    color: '#D4D4D8',
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
  },
  okButton: {
    backgroundColor: '#3E4048',
    borderRadius: 22,
    paddingVertical: 9,
    paddingHorizontal: 28,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  okButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
