/**
 * Compact text-formatting UI shared by the PDF and image "Edit Text" panels: a content-sized
 * editor sheet (Cancel / title / Done), a grouped format card with labelled rows, and the row
 * controls (font family, bold/italic, size stepper + presets, colour swatches, alignment).
 *
 * Visible text is small; every control keeps a comfortable touch target (>= 36pt with hit slop).
 */
import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeProvider';
import { Icon } from './Icon';
import { IconName } from './icons';
import { haptic } from './haptics';
import { BarButton, BarRow } from './controls';
import { fontWeights, radius, spacing, typography } from '../constants/theme';

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

export interface EditorSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly confirmLabel?: string;
  readonly confirmDisabled?: boolean;
  /** Shows a spinner in place of the confirm button (native work in progress). */
  readonly confirmLoading?: boolean;
  readonly children: React.ReactNode;
}

/**
 * Bottom sheet sized to its content (max ~88% of the window). The keyboard pushes it up on both
 * platforms; KeyboardAvoidingView measures its own frame, so a window that the system already
 * resized is not padded twice.
 */
export const EditorSheet: React.FC<EditorSheetProps> = ({
  visible,
  title,
  onCancel,
  onConfirm,
  confirmLabel = 'Done',
  confirmDisabled,
  confirmLoading,
  children,
}) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="slide" statusBarTranslucent onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior="padding" style={styles.sheetRoot}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
          onPress={onCancel}
          accessibilityLabel="Cancel editing"
          accessibilityRole="button"
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { backgroundColor: colors.groupedBackground, maxHeight: height * 0.88, paddingBottom: Math.max(insets.bottom, spacing.sm) },
          ]}>
          <View style={styles.grabberRow}>
            <View style={[styles.grabber, { backgroundColor: colors.fill }]} />
          </View>
          <BarRow
            height={44}
            style={styles.sheetHeader}
            title={title}
            left={<BarButton label="Cancel" onPress={onCancel} disabled={confirmLoading} />}
            right={
              <BarButton
                label={confirmLabel}
                prominent
                onPress={onConfirm}
                disabled={confirmDisabled}
                loading={confirmLoading}
                accessibilityLabel={confirmLabel}
              />
            }
          />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            bounces={false}
            contentContainerStyle={styles.sheetBody}
            showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Grouped card + rows
// ---------------------------------------------------------------------------

export const FormatGroup: React.FC<{ children: React.ReactNode; style?: StyleProp<ViewStyle> }> = ({ children, style }) => {
  const { colors } = useTheme();
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={[styles.group, { backgroundColor: colors.cell }, style]}>
      {rows.map((row, i) => (
        <React.Fragment key={i}>
          {i > 0 && <View style={[styles.groupSeparator, { backgroundColor: colors.separator }]} />}
          {row}
        </React.Fragment>
      ))}
    </View>
  );
};

/** Labelled row: short caption on the left, control(s) filling the rest. */
export const FormatRow: React.FC<{
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  accessibilityHint?: string;
}> = ({ label, children, disabled, accessibilityHint }) => {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.row, disabled && styles.disabled]}
      pointerEvents={disabled ? 'none' : 'auto'}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}>
      <Text style={[styles.rowLabel, { color: colors.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.rowControl}>{children}</View>
    </View>
  );
};

/** Small note under the text field (e.g. why some options are locked). */
export const FormatNote: React.FC<{ icon?: IconName; children: React.ReactNode }> = ({ icon = 'info', children }) => {
  const { colors } = useTheme();
  return (
    <View style={styles.note}>
      <Icon name={icon} size={14} color={colors.textMuted} />
      <Text style={[styles.noteText, { color: colors.textMuted }]}>{children}</Text>
    </View>
  );
};

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** Compact segmented choice (font family, alignment). */
export function ChoiceSegments<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: readonly { value: T; label?: string; icon?: IconName; accessibilityLabel?: string; fontFamily?: string }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, dark } = useTheme();
  return (
    <View style={[styles.segments, { backgroundColor: colors.fillTertiary }, style]} accessibilityRole="tablist">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="tab"
            accessibilityLabel={opt.accessibilityLabel ?? opt.label}
            accessibilityState={{ selected }}
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => {
              if (!selected) {
                haptic('selection');
                onChange(opt.value);
              }
            }}
            style={[styles.segment, selected && [styles.segmentSelected, { backgroundColor: dark ? '#636366' : '#FFFFFF' }]]}>
            {opt.icon ? (
              <Icon name={opt.icon} size={16} color={colors.textPrimary} weight={selected ? 2.2 : 1.8} />
            ) : (
              <Text
                numberOfLines={1}
                style={[
                  styles.segmentText,
                  { color: colors.textPrimary },
                  opt.fontFamily ? { fontFamily: opt.fontFamily } : null,
                  selected && styles.segmentTextSelected,
                ]}>
                {opt.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Square toggle (Bold, Italic). */
export const ToggleButton: React.FC<{
  icon: IconName;
  label: string;
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
}> = ({ icon, label, active, onToggle, disabled }) => {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptic('selection');
        onToggle();
      }}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled: !!disabled }}
      style={[styles.toggle, { backgroundColor: active ? colors.primary : colors.fillTertiary }]}>
      <Icon name={icon} size={16} color={active ? colors.onPrimary : colors.textPrimary} weight={2.2} />
    </Pressable>
  );
};

/** − value + stepper with optional preset chips. */
export const SizeStepper: React.FC<{
  value: number;
  unit?: string;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  presets?: readonly number[];
}> = ({ value, unit = 'pt', onChange, min, max, step = 1, presets }) => {
  const { colors } = useTheme();
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const stepButton = (delta: number, icon: IconName, label: string) => {
    const disabled = delta < 0 ? value <= min : value >= max;
    return (
      <Pressable
        onPress={() => {
          haptic('selection');
          onChange(clamp(value + delta));
        }}
        disabled={disabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={[styles.stepBtn, { backgroundColor: colors.fillTertiary }, disabled && styles.disabled]}>
        <Icon name={icon} size={14} color={colors.textPrimary} weight={2.4} />
      </Pressable>
    );
  };
  return (
    <View style={styles.sizeWrap}>
      <View style={styles.stepper}>
        {stepButton(-step, 'minus', 'Smaller')}
        <Text style={[styles.sizeValue, { color: colors.textPrimary }]} accessibilityLabel={`Size ${value} ${unit}`}>
          {value}
          <Text style={[styles.sizeUnit, { color: colors.textMuted }]}> {unit}</Text>
        </Text>
        {stepButton(step, 'plus', 'Larger')}
      </View>
      {presets && presets.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presets} keyboardShouldPersistTaps="handled">
          {presets.map((p) => {
            const active = p === value;
            return (
              <Pressable
                key={p}
                onPress={() => {
                  haptic('selection');
                  onChange(clamp(p));
                }}
                hitSlop={{ top: 6, bottom: 6 }}
                accessibilityRole="button"
                accessibilityLabel={`${p} ${unit}`}
                accessibilityState={{ selected: active }}
                style={[styles.preset, { backgroundColor: active ? colors.primary : colors.fillTertiary }]}>
                <Text style={[styles.presetText, { color: active ? colors.onPrimary : colors.textPrimary }]}>{p}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
};

/** Colour swatches in one scrollable row. */
export const ColorSwatches: React.FC<{
  colors: readonly string[];
  value: string;
  onChange: (hex: string) => void;
  accessibilityPrefix?: string;
}> = ({ colors: swatches, value, onChange, accessibilityPrefix = 'Colour' }) => {
  const { colors } = useTheme();
  const current = value.toUpperCase();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatches} keyboardShouldPersistTaps="handled">
      {swatches.map((hex) => {
        const active = current === hex.toUpperCase();
        return (
          <Pressable
            key={hex}
            onPress={() => {
              haptic('selection');
              onChange(hex);
            }}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={`${accessibilityPrefix} ${colorName(hex)}`}
            accessibilityState={{ selected: active }}
            style={[styles.swatchRing, { borderColor: active ? colors.primary : 'transparent' }]}>
            <View style={[styles.swatch, { backgroundColor: hex, borderColor: colors.separator }]} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
};

const COLOR_NAMES: Record<string, string> = {
  '#000000': 'Black',
  '#3A3A3C': 'Dark Grey',
  '#8E8E93': 'Grey',
  '#FFFFFF': 'White',
  '#007AFF': 'Blue',
  '#34C759': 'Green',
  '#FF3B30': 'Red',
  '#FF9500': 'Orange',
  '#AF52DE': 'Purple',
  '#FFD60A': 'Yellow',
  '#FFE066': 'Yellow',
  '#FF2D55': 'Pink',
  '#5AC8FA': 'Light Blue',
};

/** Human colour name for accessibility (falls back to the hex value). */
export function colorName(hex: string): string {
  return COLOR_NAMES[hex.toUpperCase()] ?? hex.toUpperCase();
}

const styles = StyleSheet.create({
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  grabberRow: { alignItems: 'center', paddingTop: 6 },
  grabber: { width: 36, height: 5, borderRadius: 3 },
  sheetHeader: { paddingHorizontal: spacing.xs },
  sheetBody: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm + 2 },
  group: { borderRadius: radius.md, overflow: 'hidden' },
  groupSeparator: { height: StyleSheet.hairlineWidth, marginLeft: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 46, paddingHorizontal: spacing.md, paddingVertical: 6, gap: spacing.sm },
  rowLabel: { ...typography.footnote, width: 52 },
  rowControl: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  disabled: { opacity: 0.38 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 2 },
  noteText: { ...typography.caption, flex: 1 },
  segments: { flex: 1, flexDirection: 'row', borderRadius: 8, padding: 2 },
  segment: { flex: 1, minHeight: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 6, paddingHorizontal: 4 },
  segmentSelected: {
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentText: { ...typography.footnote },
  segmentTextSelected: { fontWeight: fontWeights.semibold },
  toggle: { width: 34, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sizeWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sizeValue: { ...typography.subhead, fontWeight: fontWeights.semibold, minWidth: 48, textAlign: 'center' },
  sizeUnit: { ...typography.caption, fontWeight: fontWeights.regular },
  presets: { gap: 6, alignItems: 'center', paddingRight: 2 },
  preset: { minWidth: 32, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  presetText: { ...typography.footnote, fontWeight: fontWeights.medium },
  swatches: { gap: 4, alignItems: 'center', paddingRight: 2 },
  swatchRing: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 24, height: 24, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
});
