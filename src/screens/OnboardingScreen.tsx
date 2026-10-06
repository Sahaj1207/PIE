/**
 * First-launch welcome (shown once; can be reopened from Settings → "Welcome Tour").
 */
import React, { useRef, useState } from 'react';
import {
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ui/ThemeProvider';
import { Icon } from '../ui/Icon';
import { IconName } from '../ui/icons';
import { BarButton, PillButton } from '../ui/controls';
import { appSettings, useAppSettings } from '../settings/appSettings';
import { spacing, typography } from '../constants/theme';

declare const process: any;

interface Slide {
  readonly icon: IconName;
  readonly tint: 'primary' | 'pdfTint' | 'imageTint' | 'success';
  readonly title: string;
  readonly body: string;
}

const SLIDES: readonly Slide[] = [
  {
    icon: 'docText',
    tint: 'pdfTint',
    title: 'Edit PDFs Directly',
    body: 'Tap any text in a PDF to change or delete it, add new text, sign, highlight and reorganise pages.',
  },
  {
    icon: 'scanText',
    tint: 'imageTint',
    title: 'Edit Text in Photos',
    body: 'PIE finds the text in screenshots and photos. Replace or remove it and the background is rebuilt for you.',
  },
  {
    icon: 'shield',
    tint: 'success',
    title: 'Private by Design',
    body: 'Everything happens on this device. No account, no uploads, no cloud — your documents never leave your phone.',
  },
];

export const OnboardingView: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const last = index === SLIDES.length - 1;

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width));
    if (i !== index) setIndex(Math.max(0, Math.min(SLIDES.length - 1, i)));
  };

  const next = () => {
    if (last) {
      onDone();
      return;
    }
    scrollRef.current?.scrollTo({ x: (index + 1) * width, animated: true });
    setIndex(index + 1);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.groupedBackground, paddingTop: insets.top, paddingBottom: insets.bottom + spacing.lg }]}>
      <View style={styles.skipRow}>{!last && <BarButton label="Skip" onPress={onDone} />}</View>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        style={styles.pager}>
        {SLIDES.map((slide) => (
          <View key={slide.title} style={[styles.slide, { width }]}>
            <View style={[styles.iconCircle, { backgroundColor: colors[slide.tint] }]}>
              <Icon name={slide.icon} size={64} color="#FFFFFF" weight={1.6} />
            </View>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{slide.title}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>{slide.body}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={styles.dots} accessibilityLabel={`Page ${index + 1} of ${SLIDES.length}`}>
        {SLIDES.map((s, i) => (
          <View key={s.title} style={[styles.dot, { backgroundColor: i === index ? colors.primary : colors.fill }]} />
        ))}
      </View>
      <PillButton label={last ? 'Get Started' : 'Continue'} onPress={next} large style={styles.cta} />
    </View>
  );
};

/** Shows the welcome once, after settings have loaded (never in Jest). */
export const OnboardingGate: React.FC = () => {
  const settings = useAppSettings();
  const isTest = typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test';
  if (isTest || !appSettings.isLoaded() || settings.onboardingComplete) return null;
  return (
    <Modal visible animationType="fade" statusBarTranslucent onRequestClose={() => {
      appSettings.update({ onboardingComplete: true });
    }}>
      <OnboardingView
        onDone={() => {
          appSettings.update({ onboardingComplete: true });
        }}
      />
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  skipRow: { height: 44, flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: spacing.sm },
  pager: { flex: 1 },
  slide: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxxl },
  iconCircle: {
    width: 112,
    height: 112,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xxl,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  title: { ...typography.titleLarge, textAlign: 'center', marginBottom: spacing.md },
  body: { ...typography.bodyMedium, textAlign: 'center', lineHeight: 21 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: spacing.xl },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cta: { marginHorizontal: spacing.xl },
});
