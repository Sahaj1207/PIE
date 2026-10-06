/**
 * iOS Markup-style tool palette: pen, highlighter, shapes, undo-last-stroke, colours and
 * line widths. Used by the PDF and image editors.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../ui/ThemeProvider';
import { Icon } from '../../ui/Icon';
import { IconName } from '../../ui/icons';
import { haptic } from '../../ui/haptics';
import {
  HIGHLIGHTER_COLORS,
  MARKUP_COLORS,
  MARKUP_WIDTHS,
  MarkupTool,
} from '../../features/markup/markupModel';
import { spacing } from '../../constants/theme';

const TOOLS: readonly { tool: MarkupTool; icon: IconName; label: string }[] = [
  { tool: 'pen', icon: 'scribble', label: 'Pen' },
  { tool: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
  { tool: 'rect', icon: 'rectangle', label: 'Rectangle' },
  { tool: 'ellipse', icon: 'ellipse', label: 'Oval' },
  { tool: 'line', icon: 'line', label: 'Line' },
  { tool: 'arrow', icon: 'arrow', label: 'Arrow' },
];

export interface MarkupToolbarProps {
  readonly tool: MarkupTool;
  readonly color: string;
  readonly widthIndex: number;
  readonly canUndoStroke: boolean;
  readonly onToolChange: (tool: MarkupTool) => void;
  readonly onColorChange: (color: string) => void;
  readonly onWidthChange: (index: number) => void;
  readonly onUndoStroke: () => void;
}

export const MarkupToolbar: React.FC<MarkupToolbarProps> = ({
  tool,
  color,
  widthIndex,
  canUndoStroke,
  onToolChange,
  onColorChange,
  onWidthChange,
  onUndoStroke,
}) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const palette = tool === 'highlighter' ? HIGHLIGHTER_COLORS : MARKUP_COLORS;

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.bar, borderTopColor: colors.separator, paddingBottom: Math.max(insets.bottom, spacing.sm) },
      ]}>
      <View style={styles.toolsRow}>
        {TOOLS.map((t) => {
          const active = t.tool === tool;
          return (
            <Pressable
              key={t.tool}
              accessibilityRole="button"
              accessibilityLabel={t.label}
              accessibilityState={{ selected: active }}
              onPress={() => {
                haptic('selection');
                onToolChange(t.tool);
              }}
              style={[styles.toolBtn, active && { backgroundColor: colors.primarySubtle }]}>
              <Icon name={t.icon} size={24} color={active ? colors.primary : colors.textPrimary} />
            </Pressable>
          );
        })}
        <View style={[styles.divider, { backgroundColor: colors.separator }]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo last drawing"
          disabled={!canUndoStroke}
          onPress={() => {
            haptic('selection');
            onUndoStroke();
          }}
          style={[styles.toolBtn, !canUndoStroke && { opacity: 0.3 }]}>
          <Icon name="undo" size={22} color={colors.textPrimary} />
        </Pressable>
      </View>
      <View style={styles.styleRow}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatches}>
          {palette.map((c) => {
            const active = c.toLowerCase() === color.toLowerCase();
            return (
              <Pressable
                key={c}
                accessibilityRole="button"
                accessibilityLabel={`Colour ${c}`}
                accessibilityState={{ selected: active }}
                onPress={() => {
                  haptic('selection');
                  onColorChange(c);
                }}
                style={[styles.swatchRing, { borderColor: active ? colors.primary : 'transparent' }]}>
                <View style={[styles.swatch, { backgroundColor: c, borderColor: colors.separator }]} />
              </Pressable>
            );
          })}
        </ScrollView>
        <View style={styles.widths}>
          {MARKUP_WIDTHS.map((w, i) => {
            const active = i === widthIndex;
            return (
              <Pressable
                key={w}
                accessibilityRole="button"
                accessibilityLabel={['Thin', 'Medium', 'Thick'][i] ?? `Width ${w}`}
                accessibilityState={{ selected: active }}
                onPress={() => {
                  haptic('selection');
                  onWidthChange(i);
                }}
                style={[styles.widthBtn, active && { backgroundColor: colors.fillTertiary }]}>
                <View style={{ width: 18, height: Math.max(2, w * 1.2), borderRadius: 3, backgroundColor: colors.textPrimary }} />
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.xs },
  toolsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: spacing.sm },
  toolBtn: { width: 44, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  divider: { width: StyleSheet.hairlineWidth, height: 24 },
  styleRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, marginTop: 4 },
  swatches: { alignItems: 'center', paddingRight: spacing.sm, gap: 4 },
  swatchRing: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 24, height: 24, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  widths: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', gap: 2 },
  widthBtn: { width: 36, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
