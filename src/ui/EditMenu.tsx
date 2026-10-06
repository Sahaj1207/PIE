/**
 * iOS-style edit menu for a selection on a document canvas (PDF text object, OCR region, added
 * text): a compact dark capsule docked above the toolbar, so it never covers the selected text.
 * An optional preview line shows exactly what is selected. Items scroll horizontally when they
 * do not fit; the trailing ✕ clears the selection.
 */
import React from 'react';
import { Pressable, ScrollView, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from './ThemeProvider';
import { Icon } from './Icon';
import { IconName } from './icons';
import { haptic } from './haptics';
import { fontWeights, spacing, typography } from '../constants/theme';

export interface EditMenuItem {
  readonly key: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly onPress: () => void;
  readonly destructive?: boolean;
  /** Emphasised primary action (e.g. Edit). */
  readonly primary?: boolean;
  readonly disabled?: boolean;
  /** Small colour dot after the label (current markup colour). */
  readonly swatch?: string;
  readonly accessibilityLabel?: string;
}

/** Inline colour choice replacing the items (e.g. "Highlight" -> pick a colour to apply). */
export interface EditMenuColorChooser {
  readonly label: string;
  readonly colors: readonly string[];
  /** Current colour (shown with a ring). */
  readonly value: string;
  readonly onPick: (hex: string) => void;
  readonly onBack: () => void;
}

export const EditMenu: React.FC<{
  items: readonly EditMenuItem[];
  onClose: () => void;
  /** Selected text preview (one line). */
  preview?: string;
  disabled?: boolean;
  /** When set, the menu shows colour swatches instead of the items. */
  colorChooser?: EditMenuColorChooser | null;
  style?: StyleProp<ViewStyle>;
}> = ({ items, onClose, preview, disabled, colorChooser, style }) => {
  const { colors } = useTheme();
  const destructiveColor = '#FF6961';
  const cleanPreview = preview ? preview.replace(/\s+/g, ' ').trim() : '';
  return (
    <View style={[styles.wrap, style]} pointerEvents="box-none">
      <View style={[styles.menu, { backgroundColor: colors.hud }]} accessibilityRole="menu">
        {!!cleanPreview && (
          <Text style={[styles.preview, { color: 'rgba(255,255,255,0.62)' }]} numberOfLines={1} ellipsizeMode="tail">
            “{cleanPreview}”
          </Text>
        )}
        {colorChooser ? (
          <View style={styles.row}>
            <Pressable
              onPress={colorChooser.onBack}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Back to actions"
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
              <Icon name="chevronLeft" size={15} color={colors.onHud} weight={2.2} />
            </Pressable>
            <Text style={[styles.label, styles.chooserLabel, { color: colors.onHud }]}>{colorChooser.label}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.items} style={styles.scroll}>
              {colorChooser.colors.map((hex) => {
                const active = hex.toUpperCase() === colorChooser.value.toUpperCase();
                return (
                  <Pressable
                    key={hex}
                    onPress={() => {
                      haptic('selection');
                      colorChooser.onPick(hex);
                    }}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={`${colorChooser.label} ${hex}`}
                    accessibilityState={{ selected: active }}
                    style={({ pressed }) => [styles.swatchHit, pressed && styles.pressed]}>
                    <View style={[styles.swatchRing, active && styles.swatchRingActive]}>
                      <View style={[styles.bigSwatch, { backgroundColor: hex }]} />
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : (
        <View style={styles.row}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.items}
            keyboardShouldPersistTaps="handled"
            style={styles.scroll}>
            {items.map((item, i) => {
              const tint = item.destructive ? destructiveColor : colors.onHud;
              const isDisabled = disabled || item.disabled;
              return (
                <Pressable
                  key={item.key}
                  onPress={() => {
                    haptic('selection');
                    item.onPress();
                  }}
                  disabled={isDisabled}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.accessibilityLabel ?? item.label}
                  accessibilityState={{ disabled: !!isDisabled }}
                  style={({ pressed }) => [
                    styles.item,
                    i > 0 && styles.divider,
                    pressed && styles.pressed,
                    isDisabled && styles.dim,
                  ]}>
                  {item.icon && <Icon name={item.icon} size={15} color={tint} weight={item.primary ? 2.2 : 1.9} />}
                  <Text style={[styles.label, { color: tint }, item.primary && styles.primaryLabel]}>{item.label}</Text>
                  {item.swatch && <View style={[styles.swatch, { backgroundColor: item.swatch }]} />}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable
            onPress={onClose}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Clear selection"
            style={({ pressed }) => [styles.close, styles.divider, pressed && styles.pressed]}>
            <Icon name="close" size={14} color={colors.onHud} weight={2.2} />
          </Pressable>
        </View>
        )}
      </View>
    </View>
  );
};

/** Floating one-line coach mark (e.g. "Tap highlighted text to edit it"). */
export const HintPill: React.FC<{
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}> = ({ text, actionLabel, onAction, icon, style }) => {
  const { colors } = useTheme();
  return (
    <View style={[styles.hint, { backgroundColor: colors.hud }, style]} accessibilityLiveRegion="polite">
      {icon && <Icon name={icon} size={15} color={colors.onHud} />}
      <Text style={[styles.hintText, { color: colors.onHud }]} numberOfLines={2}>
        {text}
      </Text>
      {!!actionLabel && onAction && (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button" accessibilityLabel={actionLabel}>
          <Text style={[styles.hintAction, { color: colors.accent }]}>{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.md, alignItems: 'center' },
  menu: {
    maxWidth: '100%',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  preview: { ...typography.caption, paddingHorizontal: spacing.md, paddingTop: 7, maxWidth: 320 },
  row: { flexDirection: 'row', alignItems: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  items: { alignItems: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 42 },
  divider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: 'rgba(255,255,255,0.22)' },
  pressed: { backgroundColor: 'rgba(255,255,255,0.14)' },
  dim: { opacity: 0.4 },
  label: { ...typography.subhead, fontWeight: fontWeights.regular },
  primaryLabel: { fontWeight: fontWeights.semibold },
  swatch: { width: 9, height: 9, borderRadius: 5, marginLeft: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.6)' },
  close: { width: 38, height: 42, alignItems: 'center', justifyContent: 'center' },
  chooserLabel: { paddingRight: 6 },
  swatchHit: { width: 38, height: 42, alignItems: 'center', justifyContent: 'center' },
  swatchRing: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  swatchRingActive: { borderColor: '#FFFFFF' },
  bigSwatch: { width: 20, height: 20, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.5)' },
  hint: {
    position: 'absolute',
    top: spacing.md,
    alignSelf: 'center',
    maxWidth: '90%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: 8,
    borderRadius: 18,
  },
  hintText: { ...typography.footnote, fontWeight: fontWeights.medium, flexShrink: 1 },
  hintAction: { ...typography.footnote, fontWeight: fontWeights.bold },
});
