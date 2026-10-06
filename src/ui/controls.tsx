/**
 * iOS-style building blocks: navigation bar, bottom toolbar, bar/icon buttons, segmented
 * control, search field, grouped list rows, empty state, bottom sheet and error boundary.
 */
import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  ViewStyle,
  useWindowDimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeProvider';
import { Icon } from './Icon';
import { IconName } from './icons';
import { haptic } from './haptics';
import { useSheetAnimation } from './overlays';
import { MIN_TOUCH_TARGET, fontWeights, radius, spacing, typography } from '../constants/theme';

// ---------------------------------------------------------------------------
// Bar buttons
// ---------------------------------------------------------------------------

export interface BarButtonProps {
  readonly icon?: IconName;
  readonly label?: string;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  /** Bold label (iOS "Done"). */
  readonly prominent?: boolean;
  readonly destructive?: boolean;
  readonly color?: string;
  readonly accessibilityLabel?: string;
  readonly iconSize?: number;
  readonly testID?: string;
}

/** Plain tinted bar button (icon and/or label), 44pt hit target. */
export const BarButton: React.FC<BarButtonProps> = ({
  icon,
  label,
  onPress,
  disabled,
  loading,
  prominent,
  destructive,
  color,
  accessibilityLabel,
  iconSize = 22,
  testID,
}) => {
  const { colors } = useTheme();
  const tint = color ?? (destructive ? colors.danger : colors.primary);
  return (
    <Pressable
      testID={testID}
      onPress={() => {
        haptic('selection');
        onPress?.();
      }}
      disabled={disabled || loading}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      style={({ pressed }) => [styles.barButton, (pressed || disabled) && { opacity: disabled ? 0.3 : 0.5 }]}>
      {loading ? (
        <ActivityIndicator size="small" color={tint} />
      ) : (
        <>
          {icon && <Icon name={icon} size={iconSize} color={tint} />}
          {!!label && (
            <Text
              numberOfLines={1}
              style={[styles.barButtonText, { color: tint }, prominent && styles.barButtonProminent, icon ? { marginLeft: 2 } : null]}>
              {label}
            </Text>
          )}
        </>
      )}
    </Pressable>
  );
};

/** Filled pill button (e.g. Save). */
export const PillButton: React.FC<{
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: 'primary' | 'secondary' | 'destructive';
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  large?: boolean;
}> = ({ label, onPress, disabled, loading, tone = 'primary', icon, style, accessibilityLabel, large }) => {
  const { colors } = useTheme();
  const bg = tone === 'primary' ? colors.primary : tone === 'destructive' ? colors.danger : colors.fill;
  const fg = tone === 'secondary' ? colors.primary : colors.onPrimary;
  return (
    <Pressable
      onPress={() => {
        haptic('light');
        onPress();
      }}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      style={({ pressed }) => [
        large ? styles.pillLarge : styles.pill,
        { backgroundColor: bg },
        (pressed || disabled) && { opacity: disabled ? 0.35 : 0.75 },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <View style={styles.pillContent}>
          {icon && <Icon name={icon} size={large ? 20 : 17} color={fg} weight={2} />}
          <Text style={[large ? styles.pillLargeText : styles.pillText, { color: fg }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
};

// ---------------------------------------------------------------------------
// Navigation bar
// ---------------------------------------------------------------------------

export interface NavBarProps {
  readonly title?: string;
  readonly subtitle?: string;
  readonly left?: React.ReactNode;
  readonly right?: React.ReactNode;
  /** Large-title header (Library, Settings). */
  readonly large?: boolean;
  /** Content shown under the large title (e.g. a search field). */
  readonly accessory?: React.ReactNode;
  readonly transparent?: boolean;
}

/** Narrowest title area worth centring; below this the title uses all space between the sides. */
export const NAV_MIN_CENTERED_TITLE_WIDTH = 120;
/** Gap kept between the title and the bar items on either side. */
export const NAV_TITLE_GAP = 8;

/**
 * Horizontal placement of a navigation-bar title between its bar items (iOS behaviour): centred
 * in the bar when that leaves enough room, otherwise filling the space between the left and right
 * items. The title can therefore never overlap (or steal touches from) the bar items.
 */
export function navTitleInsets(
  barWidth: number,
  leftWidth: number,
  rightWidth: number,
): { left: number; right: number; centered: boolean } {
  const symmetric = Math.max(leftWidth, rightWidth) + NAV_TITLE_GAP;
  if (barWidth - symmetric * 2 >= NAV_MIN_CENTERED_TITLE_WIDTH) {
    return { left: symmetric, right: symmetric, centered: true };
  }
  return { left: leftWidth + NAV_TITLE_GAP, right: rightWidth + NAV_TITLE_GAP, centered: false };
}

/**
 * One bar row: left items, right items and a centred title. The items are content-sized with
 * their own touch areas; the title is a non-interactive layer placed by `navTitleInsets`, always
 * one line with a tail ellipsis. Used by navigation bars and sheet headers.
 */
export const BarRow: React.FC<{
  title?: string;
  subtitle?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  height?: number;
  style?: StyleProp<ViewStyle>;
}> = ({ title, subtitle, left, right, height = 44, style }) => {
  const { colors } = useTheme();
  const [widths, setWidths] = React.useState({ bar: 0, left: 0, right: 0 });
  const measure = (key: 'bar' | 'left' | 'right') => (e: { nativeEvent: { layout: { width: number } } }) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidths((prev) => (prev[key] === w ? prev : { ...prev, [key]: w }));
  };
  const placement = navTitleInsets(widths.bar, widths.left, widths.right);
  return (
    <View style={[styles.navRow, { height }, style]} onLayout={measure('bar')}>
      {(!!title || !!subtitle) && (
        <View
          pointerEvents="none"
          style={[styles.navTitleBox, { left: placement.left, right: placement.right, opacity: widths.bar > 0 ? 1 : 0 }]}>
          {!!title && (
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={[styles.navTitle, { color: colors.textPrimary }]}
              accessibilityRole="header">
              {title}
            </Text>
          )}
          {!!subtitle && (
            <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.navSubtitle, { color: colors.textMuted }]}>
              {subtitle}
            </Text>
          )}
        </View>
      )}
      <View style={styles.navSide} onLayout={measure('left')}>
        {left}
      </View>
      <View style={styles.navSpacer} pointerEvents="none" />
      <View style={[styles.navSide, styles.navSideRight]} onLayout={measure('right')}>
        {right}
      </View>
    </View>
  );
};

export const NavBar: React.FC<NavBarProps> = ({ title, subtitle, left, right, large, accessory, transparent }) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        { paddingTop: insets.top, backgroundColor: transparent ? 'transparent' : colors.bar },
        !large && !transparent && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
      ]}>
      <BarRow title={large ? undefined : title} subtitle={large ? undefined : subtitle} left={left} right={right} />
      {large && (
        <View style={styles.largeTitleBox}>
          <Text style={[styles.largeTitle, { color: colors.textPrimary }]} accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
          {!!subtitle && <Text style={[styles.largeSubtitle, { color: colors.textSecondary }]}>{subtitle}</Text>}
        </View>
      )}
      {accessory}
    </View>
  );
};

/**
 * Back button with chevron and label ("‹ Library"). `compact` shows the chevron only (editors,
 * where the document title needs the room); the accessibility label still names the target.
 */
export const BackButton: React.FC<{ label?: string; onPress: () => void; disabled?: boolean; compact?: boolean }> = ({
  label = 'Back',
  onPress,
  disabled,
  compact,
}) => (
  <BarButton
    icon="chevronLeft"
    label={compact ? undefined : label}
    onPress={onPress}
    disabled={disabled}
    iconSize={compact ? 26 : 22}
    accessibilityLabel={`Back to ${label}`}
    testID="nav-back"
  />
);

// ---------------------------------------------------------------------------
// Bottom toolbar
// ---------------------------------------------------------------------------

export interface ToolbarItem {
  readonly key: string;
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly active?: boolean;
  readonly loading?: boolean;
  readonly destructive?: boolean;
}

export const Toolbar: React.FC<{ items: readonly ToolbarItem[]; showLabels?: boolean; children?: React.ReactNode }> = ({
  items,
  showLabels = true,
  children,
}) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.toolbar,
        { backgroundColor: colors.bar, borderTopColor: colors.separator, paddingBottom: Math.max(insets.bottom, spacing.xs) },
      ]}>
      {children}
      <View style={styles.toolbarRow}>
        {items.map((item) => {
          const tint = item.destructive ? colors.danger : colors.primary;
          return (
            <Pressable
              key={item.key}
              onPress={() => {
                haptic('selection');
                item.onPress();
              }}
              disabled={item.disabled || item.loading}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ disabled: !!item.disabled, selected: !!item.active, busy: !!item.loading }}
              style={({ pressed }) => [
                styles.toolbarItem,
                item.active && { backgroundColor: colors.primarySubtle },
                (pressed || item.disabled) && { opacity: item.disabled ? 0.3 : 0.55 },
              ]}>
              {item.loading ? (
                <ActivityIndicator size="small" color={colors.primary} style={{ height: 24 }} />
              ) : (
                <Icon name={item.icon} size={22} color={tint} />
              )}
              {showLabels && (
                <Text numberOfLines={1} style={[styles.toolbarLabel, { color: tint }]}>
                  {item.label}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  style,
}: {
  segments: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, dark } = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: colors.fillTertiary }, style]} accessibilityRole="tablist">
      {segments.map((segment) => {
        const selected = segment.value === value;
        return (
          <Pressable
            key={segment.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) {
                haptic('selection');
                onChange(segment.value);
              }
            }}
            style={[
              styles.segment,
              selected && [styles.segmentSelected, { backgroundColor: dark ? '#636366' : '#FFFFFF' }],
            ]}>
            <Text numberOfLines={1} style={[styles.segmentText, { color: colors.textPrimary }, selected && styles.segmentTextSelected]}>
              {segment.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Search field
// ---------------------------------------------------------------------------

export const SearchField: React.FC<{
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  style?: StyleProp<ViewStyle>;
}> = ({ value, onChangeText, placeholder = 'Search', autoFocus, onSubmit, style }) => {
  const { colors } = useTheme();
  return (
    <View style={[styles.search, { backgroundColor: colors.fillTertiary }, style]}>
      <Icon name="search" size={17} color={colors.textMuted} weight={2.2} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoFocus={autoFocus}
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={onSubmit}
        accessibilityLabel={placeholder}
        style={[styles.searchInput, { color: colors.textPrimary }]}
      />
      {value.length > 0 && (
        <Pressable onPress={() => onChangeText('')} hitSlop={10} accessibilityLabel="Clear search" accessibilityRole="button">
          <Icon name="closeCircle" size={17} color={colors.textMuted} knockoutColor={colors.cell} />
        </Pressable>
      )}
    </View>
  );
};

// ---------------------------------------------------------------------------
// Grouped list (Settings-style)
// ---------------------------------------------------------------------------

export const ListSection: React.FC<{ header?: string; footer?: string; children: React.ReactNode }> = ({
  header,
  footer,
  children,
}) => {
  const { colors } = useTheme();
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.section}>
      {!!header && <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>{header.toUpperCase()}</Text>}
      <View style={[styles.sectionBody, { backgroundColor: colors.cell }]}>
        {rows.map((row, i) => (
          <React.Fragment key={i}>
            {i > 0 && <View style={[styles.rowSeparator, { backgroundColor: colors.separator }]} />}
            {row}
          </React.Fragment>
        ))}
      </View>
      {!!footer && <Text style={[styles.sectionFooter, { color: colors.textSecondary }]}>{footer}</Text>}
    </View>
  );
};

export const ListRow: React.FC<{
  title: string;
  subtitle?: string;
  value?: string;
  icon?: IconName;
  iconColor?: string;
  onPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  checked?: boolean;
  switchValue?: boolean;
  onSwitchChange?: (value: boolean) => void;
  accessibilityLabel?: string;
  right?: React.ReactNode;
}> = ({
  title,
  subtitle,
  value,
  icon,
  iconColor,
  onPress,
  chevron,
  destructive,
  checked,
  switchValue,
  onSwitchChange,
  accessibilityLabel,
  right,
}) => {
  const { colors } = useTheme();
  const content = (
    <>
      {icon && (
        <View style={[styles.rowIcon, { backgroundColor: iconColor ?? colors.primary }]}>
          <Icon name={icon} size={18} color="#FFFFFF" weight={2} />
        </View>
      )}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: destructive ? colors.danger : colors.textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]} numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
      {!!value && (
        <Text style={[styles.rowValue, { color: colors.textMuted }]} numberOfLines={1}>
          {value}
        </Text>
      )}
      {right}
      {checked && <Icon name="check" size={20} color={colors.primary} weight={2.4} />}
      {onSwitchChange && (
        <Switch
          value={!!switchValue}
          onValueChange={(v) => {
            haptic('selection');
            onSwitchChange(v);
          }}
          trackColor={{ true: colors.success, false: colors.fill }}
          thumbColor="#FFFFFF"
          ios_backgroundColor={colors.fill}
        />
      )}
      {chevron && <Icon name="chevronRight" size={16} color={colors.textMuted} weight={2.4} />}
    </>
  );
  if (!onPress) {
    return (
      <View style={styles.row} accessibilityLabel={accessibilityLabel}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={checked !== undefined ? { selected: checked } : undefined}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.cellPressed }]}>
      {content}
    </Pressable>
  );
};

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export const EmptyState: React.FC<{
  icon: IconName;
  title: string;
  message?: string;
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}> = ({ icon, title, message, action, style }) => {
  const { colors } = useTheme();
  return (
    <View style={[styles.empty, style]}>
      <Icon name={icon} size={48} color={colors.textMuted} weight={1.3} />
      <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{title}</Text>
      {!!message && <Text style={[styles.emptyMessage, { color: colors.textSecondary }]}>{message}</Text>}
      {action}
    </View>
  );
};

// ---------------------------------------------------------------------------
// Bottom sheet (page sheet with grabber)
// ---------------------------------------------------------------------------

export const BottomSheet: React.FC<{
  visible: boolean;
  onClose: () => void;
  title?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  /** Fraction of the window height (default: fit content up to 90%). */
  heightFraction?: number;
  scroll?: boolean;
  avoidKeyboard?: boolean;
}> = ({ visible, onClose, ...rest }) => {
  if (!visible) return null;
  return <BottomSheetContent onClose={onClose} {...rest} />;
};

const BottomSheetContent: React.FC<{
  onClose: () => void;
  title?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  heightFraction?: number;
  scroll?: boolean;
  avoidKeyboard?: boolean;
}> = ({ onClose, title, left, right, children, heightFraction, scroll = true, avoidKeyboard }) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const closingRef = useRef(false);
  const { progress, close } = useSheetAnimation(onClose);
  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    close();
  };
  const sheetHeight = heightFraction ? height * heightFraction : undefined;
  const body = scroll ? (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}>
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: sheetHeight ? 1 : undefined, paddingBottom: insets.bottom }}>{children}</View>
  );
  const sheet = (
    <Animated.View
      style={[
        styles.sheet,
        { backgroundColor: colors.groupedBackground, maxHeight: height * 0.92 },
        sheetHeight ? { height: sheetHeight } : null,
        { transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }] },
      ]}
      accessibilityViewIsModal>
      <View style={styles.grabberRow}>
        <View style={[styles.grabber, { backgroundColor: colors.fill }]} />
      </View>
      {(title || left || right) && <BarRow title={title} left={left} right={right} height={48} style={styles.sheetHeaderRow} />}
      {body}
    </Animated.View>
  );
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel="Close">
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay, opacity: progress }]} />
      </Pressable>
      {avoidKeyboard ? (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.sheetKeyboard} pointerEvents="box-none">
          {sheet}
        </KeyboardAvoidingView>
      ) : (
        <View style={styles.sheetKeyboard} pointerEvents="box-none">
          {sheet}
        </View>
      )}
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset?: () => void; fallbackTitle?: string },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.warn('[PIE] Unhandled render error:', error?.message);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.error) {
      return <ErrorFallback title={this.props.fallbackTitle} message={this.state.error.message} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

const ErrorFallback: React.FC<{ title?: string; message?: string; onReset: () => void }> = ({ title, message, onReset }) => {
  const { colors } = useTheme();
  return (
    <View style={[styles.errorScreen, { backgroundColor: colors.groupedBackground }]}>
      <EmptyState
        icon="info"
        title={title ?? 'Something went wrong'}
        message={`PIE hit an unexpected problem. Your saved documents are safe.${message ? `\n\n${message}` : ''}`}
        action={<PillButton label="Try Again" onPress={onReset} style={{ marginTop: spacing.lg }} large />}
      />
    </View>
  );
};

// ---------------------------------------------------------------------------
// Animated press scale (cards)
// ---------------------------------------------------------------------------

export const ScalePressable: React.FC<
  React.ComponentProps<typeof Pressable> & { children: React.ReactNode; style?: StyleProp<ViewStyle> }
> = ({ children, style, onPressIn, onPressOut, ...rest }) => {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.spring(scale, { toValue: v, useNativeDriver: true, friction: 7, tension: 160 }).start();
  useEffect(() => () => scale.stopAnimation(), [scale]);
  return (
    <Pressable
      {...rest}
      onPressIn={(e) => {
        to(0.96);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        to(1);
        onPressOut?.(e);
      }}>
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  barButton: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET - 8,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  barButtonText: { ...typography.bodyLarge },
  barButtonProminent: { fontWeight: fontWeights.semibold },
  pill: { minHeight: 34, borderRadius: radius.full, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  pillLarge: { minHeight: 48, borderRadius: radius.lg, paddingHorizontal: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  pillContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pillText: { ...typography.subhead, fontWeight: fontWeights.semibold },
  pillLargeText: { ...typography.bodyLarge, fontWeight: fontWeights.semibold },
  navRow: { height: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xs },
  navSide: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  navSideRight: { justifyContent: 'flex-end' },
  navSpacer: { flex: 1 },
  navTitleBox: { position: 'absolute', top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  navTitle: { ...typography.headline, textAlign: 'center' },
  navSubtitle: { ...typography.caption2, marginTop: 1, textAlign: 'center' },
  largeTitleBox: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  largeTitle: { ...typography.largeTitle },
  largeSubtitle: { ...typography.footnote, marginTop: 2 },
  toolbar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 2 },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: spacing.xs },
  toolbarItem: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    marginHorizontal: 2,
    paddingVertical: 3,
  },
  toolbarLabel: { fontSize: 10, lineHeight: 12, fontWeight: fontWeights.medium, marginTop: 3, letterSpacing: 0.1 },
  segmented: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  segment: { flex: 1, minHeight: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingHorizontal: spacing.sm },
  segmentSelected: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  segmentText: { ...typography.footnote, fontWeight: fontWeights.regular },
  segmentTextSelected: { fontWeight: fontWeights.semibold },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: spacing.sm,
    minHeight: 36,
    gap: 6,
  },
  searchInput: { flex: 1, ...typography.bodyLarge, lineHeight: undefined, paddingVertical: Platform.OS === 'ios' ? 7 : 2 },
  section: { marginBottom: spacing.xl + 4, paddingHorizontal: spacing.lg },
  sectionHeader: { ...typography.sectionHeader, marginLeft: spacing.lg, marginBottom: 6 },
  sectionFooter: { ...typography.caption, marginHorizontal: spacing.lg, marginTop: 6, lineHeight: 17 },
  sectionBody: { borderRadius: radius.md + 1, overflow: 'hidden' },
  rowSeparator: { height: StyleSheet.hairlineWidth, marginLeft: spacing.lg },
  row: { minHeight: 46, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 8, gap: spacing.md },
  rowIcon: { width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { ...typography.bodyLarge },
  rowSubtitle: { ...typography.caption, marginTop: 1 },
  rowValue: { ...typography.bodyLarge, maxWidth: '50%' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxl, paddingVertical: spacing.xxxl, gap: spacing.xs + 2 },
  emptyTitle: { ...typography.titleMedium, textAlign: 'center', marginTop: spacing.sm },
  emptyMessage: { ...typography.subhead, textAlign: 'center', maxWidth: 300 },
  sheetKeyboard: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  grabberRow: { alignItems: 'center', paddingTop: 6, paddingBottom: 2 },
  grabber: { width: 36, height: 5, borderRadius: 3 },
  sheetHeaderRow: { paddingHorizontal: spacing.xs },
  errorScreen: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
