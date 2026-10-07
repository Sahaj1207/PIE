/**
 * iOS-style overlays shared by every screen: alerts, action sheets, text prompts, toasts and a
 * blocking progress HUD. One `OverlayHost` (mounted in App) renders them; the imperative
 * helpers below fall back to the platform Alert when no host is mounted (tests, early startup).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AlertButton,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeProvider';
import { Icon } from './Icon';
import { IconName } from './icons';
import { haptic } from './haptics';
import { fontWeights, radius, spacing, typography } from '../constants/theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlertAction {
  readonly text: string;
  readonly style?: 'default' | 'cancel' | 'destructive';
  readonly onPress?: () => void;
}

export interface ActionSheetOption {
  readonly label: string;
  readonly icon?: IconName;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** Shows a checkmark (current choice in option lists such as View Options). */
  readonly checked?: boolean;
  readonly onPress: () => void;
}

export interface ActionSheetRequest {
  readonly title?: string;
  readonly message?: string;
  readonly options: readonly ActionSheetOption[];
  readonly cancelLabel?: string;
}

export interface PromptRequest {
  readonly title: string;
  readonly message?: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly confirmLabel?: string;
  readonly onConfirm: (value: string) => void;
  /** Returns an error message to keep the prompt open, or null when the value is valid. */
  readonly validate?: (value: string) => string | null;
  /** Keyboard capitalisation (default: sentences). Use 'none' to keep text exactly as typed. */
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}

export interface ToastRequest {
  readonly message: string;
  readonly icon?: IconName;
  readonly tone?: 'default' | 'success' | 'error';
  readonly durationMs?: number;
}

type OverlayItem =
  | { kind: 'alert'; id: number; title: string; message?: string; actions: AlertAction[] }
  | { kind: 'sheet'; id: number; request: ActionSheetRequest }
  | { kind: 'prompt'; id: number; request: PromptRequest };

interface OverlayPresenter {
  push(item: OverlayItem): void;
  toast(request: ToastRequest): void;
  progress(label: string | null): void;
}

let presenter: OverlayPresenter | null = null;
let nextId = 1;
let progressDepth = 0;

// ---------------------------------------------------------------------------
// Imperative API
// ---------------------------------------------------------------------------

/** Drop-in replacement for Alert.alert with an iOS-style dialog. */
export function showAlert(title: string, message?: string, actions?: AlertAction[]): void {
  const list = actions && actions.length > 0 ? actions : [{ text: 'OK' }];
  if (!presenter) {
    Alert.alert(title, message, list as AlertButton[]);
    return;
  }
  if (list.some((a) => a.style === 'destructive')) haptic('warning');
  presenter.push({ kind: 'alert', id: nextId++, title, message, actions: [...list] });
}

/** Promise form of a two-button confirmation (resolves true on confirm). */
export function confirmAction(
  title: string,
  message: string | undefined,
  confirmLabel: string,
  destructive = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    showAlert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ]);
  });
}

export function showActionSheet(request: ActionSheetRequest): void {
  if (!presenter) {
    const buttons: AlertButton[] = request.options
      .filter((o) => !o.disabled)
      .map((o) => ({ text: o.label, style: o.destructive ? 'destructive' : 'default', onPress: o.onPress }));
    buttons.push({ text: request.cancelLabel ?? 'Cancel', style: 'cancel' });
    Alert.alert(request.title ?? '', request.message, buttons);
    return;
  }
  haptic('selection');
  presenter.push({ kind: 'sheet', id: nextId++, request });
}

export function showPrompt(request: PromptRequest): void {
  if (!presenter) {
    // Platform fallback: confirm with the default value (no text entry without a host).
    if (request.defaultValue) request.onConfirm(request.defaultValue);
    return;
  }
  presenter.push({ kind: 'prompt', id: nextId++, request });
}

export function showToast(message: string, options: Omit<ToastRequest, 'message'> = {}): void {
  if (options.tone === 'success') haptic('success');
  else if (options.tone === 'error') haptic('error');
  presenter?.toast({ message, ...options });
}

/** Shows a blocking HUD; returns a function that hides it (nesting-safe). */
export function showProgress(label: string): () => void {
  progressDepth += 1;
  presenter?.progress(label);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    progressDepth = Math.max(0, progressDepth - 1);
    if (progressDepth === 0) presenter?.progress(null);
  };
}

/** Runs `task` behind the progress HUD. */
export async function withProgress<T>(label: string, task: () => Promise<T>): Promise<T> {
  const hide = showProgress(label);
  try {
    return await task();
  } finally {
    hide();
  }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export const OverlayHost: React.FC = () => {
  const [queue, setQueue] = useState<OverlayItem[]>([]);
  const [toast, setToast] = useState<(ToastRequest & { id: number }) | null>(null);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    presenter = {
      push: (item) => setQueue((q) => [...q, item]),
      toast: (request) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        const id = nextId++;
        setToast({ ...request, id });
        toastTimer.current = setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), request.durationMs ?? 2200);
      },
      progress: (label) => setProgressLabel(label),
    };
    return () => {
      presenter = null;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const current = queue[0] ?? null;
  const dismiss = useCallback((id: number, then?: () => void) => {
    setQueue((q) => q.filter((item) => item.id !== id));
    // Run the action after the overlay closed (it may open another overlay).
    if (then) setTimeout(then, 0);
  }, []);

  return (
    <>
      {current?.kind === 'alert' && (
        <AlertDialog
          key={current.id}
          title={current.title}
          message={current.message}
          actions={current.actions}
          onClose={(action) => dismiss(current.id, action?.onPress)}
        />
      )}
      {current?.kind === 'sheet' && (
        <ActionSheetView key={current.id} request={current.request} onClose={(fn) => dismiss(current.id, fn)} />
      )}
      {current?.kind === 'prompt' && (
        <PromptDialog key={current.id} request={current.request} onClose={(fn) => dismiss(current.id, fn)} />
      )}
      {toast && <ToastView key={toast.id} toast={toast} />}
      {progressLabel !== null && <ProgressHud label={progressLabel} />}
    </>
  );
};

// ---------------------------------------------------------------------------
// Alert (iOS UIAlertController look)
// ---------------------------------------------------------------------------

const AlertDialog: React.FC<{
  title: string;
  message?: string;
  actions: AlertAction[];
  onClose: (action?: AlertAction) => void;
}> = ({ title, message, actions, onClose }) => {
  const { colors, dark } = useTheme();
  const scale = useRef(new Animated.Value(1.12)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 8, tension: 120 }),
      Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }),
    ]).start();
  }, [scale, opacity]);

  // iOS orders: two buttons side by side (cancel left); otherwise stacked, cancel last.
  const cancel = actions.find((a) => a.style === 'cancel');
  const others = actions.filter((a) => a !== cancel);
  const horizontal = actions.length === 2;
  const ordered = horizontal ? (cancel ? [cancel, ...others] : others) : cancel ? [...others, cancel] : others;
  const dialogBg = dark ? 'rgba(44,44,46,0.98)' : 'rgba(242,242,247,0.98)';

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={() => onClose(cancel)}>
      <Animated.View style={[styles.alertBackdrop, { backgroundColor: colors.overlay, opacity }]}>
        <Animated.View
          accessibilityViewIsModal
          style={[styles.alertBox, { backgroundColor: dialogBg, transform: [{ scale }] }]}>
          <View style={styles.alertTextBlock}>
            <Text style={[styles.alertTitle, { color: colors.textPrimary }]} accessibilityRole="header">
              {title}
            </Text>
            {!!message && <Text style={[styles.alertMessage, { color: colors.textPrimary }]}>{message}</Text>}
          </View>
          <View style={[horizontal ? styles.alertRow : null, { borderTopColor: colors.separator }, styles.alertButtons]}>
            {ordered.map((action, i) => (
              <Pressable
                key={`${action.text}-${i}`}
                accessibilityRole="button"
                onPress={() => onClose(action)}
                style={({ pressed }) => [
                  styles.alertButton,
                  horizontal ? styles.alertButtonHorizontal : null,
                  i > 0 && (horizontal ? { borderLeftWidth: StyleSheet.hairlineWidth } : { borderTopWidth: StyleSheet.hairlineWidth }),
                  { borderColor: colors.separator },
                  pressed && { backgroundColor: colors.fillTertiary },
                ]}>
                <Text
                  style={[
                    styles.alertButtonText,
                    { color: action.style === 'destructive' ? colors.danger : colors.primary },
                    action.style === 'cancel' && styles.alertButtonCancel,
                  ]}>
                  {action.text}
                </Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Action sheet
// ---------------------------------------------------------------------------

export function useSheetAnimation(onClosed?: () => void) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress]);
  const close = useCallback(
    (then?: () => void) => {
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        onClosed?.();
        then?.();
      });
    },
    [progress, onClosed],
  );
  return { progress, close };
}

const ActionSheetView: React.FC<{ request: ActionSheetRequest; onClose: (then?: () => void) => void }> = ({
  request,
  onClose,
}) => {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const pending = useRef<(() => void) | undefined>(undefined);
  const { progress, close } = useSheetAnimation(() => onClose(pending.current));
  const groupBg = dark ? 'rgba(44,44,46,0.98)' : 'rgba(249,249,249,0.98)';

  const choose = (fn?: () => void) => {
    pending.current = fn;
    close();
  };

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={() => choose()}>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => choose()} accessibilityLabel="Dismiss">
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay, opacity: progress }]} />
      </Pressable>
      <Animated.View
        style={[
          styles.sheetContainer,
          { paddingBottom: Math.max(insets.bottom, spacing.sm) },
          { transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height * 0.6, 0] }) }] },
        ]}>
        <View style={[styles.sheetGroup, { backgroundColor: groupBg }]}>
          <ScrollView style={{ maxHeight: height * 0.62 }} bounces={false}>
            {(request.title || request.message) && (
              <View style={[styles.sheetHeader, { borderBottomColor: colors.separator }]}>
                {!!request.title && <Text style={[styles.sheetTitle, { color: colors.textMuted }]}>{request.title}</Text>}
                {!!request.message && (
                  <Text style={[styles.sheetMessage, { color: colors.textMuted }]}>{request.message}</Text>
                )}
              </View>
            )}
            {request.options.map((option, i) => (
              <Pressable
                key={`${option.label}-${i}`}
                disabled={option.disabled}
                accessibilityRole="button"
                accessibilityState={{ disabled: !!option.disabled, selected: option.checked }}
                onPress={() => choose(option.onPress)}
                style={({ pressed }) => [
                  styles.sheetOption,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
                  pressed && { backgroundColor: colors.fillTertiary },
                  option.disabled && { opacity: 0.4 },
                ]}>
                {option.icon && (
                  <Icon
                    name={option.icon}
                    size={20}
                    color={option.destructive ? colors.danger : colors.primary}
                    style={styles.sheetIcon}
                  />
                )}
                <Text
                  style={[styles.sheetOptionText, { color: option.destructive ? colors.danger : colors.primary }]}>
                  {option.label}
                </Text>
                {option.checked && (
                  <Icon name="check" size={18} color={colors.primary} weight={2.4} style={styles.sheetCheck} />
                )}
              </Pressable>
            ))}
          </ScrollView>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => choose()}
          style={({ pressed }) => [
            styles.sheetGroup,
            styles.sheetCancel,
            { backgroundColor: dark ? '#2C2C2E' : '#FFFFFF' },
            pressed && { backgroundColor: colors.cellPressed },
          ]}>
          <Text style={[styles.sheetCancelText, { color: colors.primary }]}>{request.cancelLabel ?? 'Cancel'}</Text>
        </Pressable>
      </Animated.View>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Prompt (text input alert, e.g. Rename)
// ---------------------------------------------------------------------------

const PromptDialog: React.FC<{ request: PromptRequest; onClose: (then?: () => void) => void }> = ({
  request,
  onClose,
}) => {
  const { colors, dark } = useTheme();
  const [value, setValue] = useState(request.defaultValue ?? '');
  const [error, setError] = useState<string | null>(null);
  const dialogBg = dark ? 'rgba(44,44,46,0.98)' : 'rgba(242,242,247,0.98)';

  const confirm = () => {
    const trimmed = value.trim();
    const problem = request.validate ? request.validate(trimmed) : trimmed.length === 0 ? 'Enter a name.' : null;
    if (problem) {
      setError(problem);
      haptic('error');
      return;
    }
    onClose(() => request.onConfirm(trimmed));
  };

  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={() => onClose()}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.alertBackdrop, { backgroundColor: colors.overlay }]}>
        <View style={[styles.alertBox, { backgroundColor: dialogBg }]} accessibilityViewIsModal>
          <View style={styles.alertTextBlock}>
            <Text style={[styles.alertTitle, { color: colors.textPrimary }]}>{request.title}</Text>
            {!!request.message && (
              <Text style={[styles.alertMessage, { color: colors.textPrimary }]}>{request.message}</Text>
            )}
            <TextInput
              value={value}
              onChangeText={(t) => {
                setValue(t);
                setError(null);
              }}
              autoFocus
              selectTextOnFocus
              autoCapitalize={request.autoCapitalize ?? 'sentences'}
              autoCorrect={request.autoCapitalize === 'none' ? false : undefined}
              placeholder={request.placeholder}
              placeholderTextColor={colors.textMuted}
              onSubmitEditing={confirm}
              returnKeyType="done"
              style={[
                styles.promptInput,
                {
                  color: colors.textPrimary,
                  backgroundColor: dark ? '#1C1C1E' : '#FFFFFF',
                  borderColor: error ? colors.danger : colors.separator,
                },
              ]}
            />
            {!!error && <Text style={[styles.promptError, { color: colors.danger }]}>{error}</Text>}
          </View>
          <View style={[styles.alertRow, styles.alertButtons, { borderTopColor: colors.separator }]}>
            <Pressable
              accessibilityRole="button"
              onPress={() => onClose()}
              style={({ pressed }) => [styles.alertButton, styles.alertButtonHorizontal, pressed && { backgroundColor: colors.fillTertiary }]}>
              <Text style={[styles.alertButtonText, { color: colors.primary }]}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={confirm}
              style={({ pressed }) => [
                styles.alertButton,
                styles.alertButtonHorizontal,
                { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: colors.separator },
                pressed && { backgroundColor: colors.fillTertiary },
              ]}>
              <Text style={[styles.alertButtonText, styles.alertButtonCancel, { color: colors.primary }]}>
                {request.confirmLabel ?? 'Save'}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Toast + progress HUD
// ---------------------------------------------------------------------------

const ToastView: React.FC<{ toast: ToastRequest }> = ({ toast }) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 9, tension: 90 }).start();
  }, [anim]);
  const icon: IconName | undefined =
    toast.icon ?? (toast.tone === 'success' ? 'checkCircle' : toast.tone === 'error' ? 'closeCircle' : undefined);
  const iconColor = toast.tone === 'error' ? colors.danger : toast.tone === 'success' ? colors.success : colors.onHud;
  return (
    <View pointerEvents="none" style={[styles.toastLayer, { top: insets.top + 8 }]}>
      <Animated.View
        accessibilityLiveRegion="polite"
        style={[
          styles.toast,
          { backgroundColor: colors.hud },
          {
            opacity: anim,
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) }],
          },
        ]}>
        {icon && <Icon name={icon} size={20} color={iconColor} knockoutColor={colors.hud} style={styles.toastIcon} />}
        <Text style={[styles.toastText, { color: colors.onHud }]} numberOfLines={2}>
          {toast.message}
        </Text>
      </Animated.View>
    </View>
  );
};

const ProgressHud: React.FC<{ label: string }> = ({ label }) => {
  const { colors } = useTheme();
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={() => {}}>
      <View style={styles.hudBackdrop} accessibilityViewIsModal>
        <View style={[styles.hud, { backgroundColor: colors.hud }]} accessibilityLiveRegion="polite">
          <ActivityIndicator size="large" color={colors.onHud} />
          {!!label && <Text style={[styles.hudText, { color: colors.onHud }]}>{label}</Text>}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  alertBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  alertBox: { width: 280, maxWidth: '100%', borderRadius: radius.lg, overflow: 'hidden' },
  alertTextBlock: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg + 2, paddingBottom: spacing.lg - 2, alignItems: 'center' },
  alertTitle: { ...typography.headline, textAlign: 'center' },
  alertMessage: { ...typography.footnote, textAlign: 'center', marginTop: 3 },
  alertButtons: { borderTopWidth: StyleSheet.hairlineWidth },
  alertRow: { flexDirection: 'row' },
  alertButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  alertButtonHorizontal: { flex: 1 },
  alertButtonText: { ...typography.bodyLarge },
  alertButtonCancel: { fontWeight: fontWeights.semibold },
  promptInput: {
    alignSelf: 'stretch',
    marginTop: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 7,
    paddingHorizontal: spacing.sm,
    paddingVertical: Platform.OS === 'ios' ? 7 : 4,
    ...typography.bodyMedium,
    lineHeight: undefined,
  },
  promptError: { ...typography.caption, marginTop: spacing.xs, textAlign: 'center' },
  sheetContainer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.sm },
  sheetGroup: { borderRadius: radius.lg, overflow: 'hidden', marginBottom: spacing.sm },
  sheetHeader: { paddingVertical: spacing.md - 1, paddingHorizontal: spacing.lg, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  sheetTitle: { ...typography.footnote, fontWeight: fontWeights.semibold, textAlign: 'center' },
  sheetMessage: { ...typography.caption, textAlign: 'center', marginTop: 2 },
  sheetOption: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxxl + spacing.md },
  sheetIcon: { position: 'absolute', left: spacing.lg },
  sheetCheck: { position: 'absolute', right: spacing.lg },
  sheetOptionText: { fontSize: 17, lineHeight: 22, letterSpacing: Platform.OS === 'ios' ? -0.41 : 0, textAlign: 'center' },
  sheetCancel: { minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  sheetCancelText: { fontSize: 17, lineHeight: 22, fontWeight: fontWeights.semibold },
  toastLayer: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg - 2,
    paddingVertical: 9,
    maxWidth: '88%',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  toastIcon: { marginRight: spacing.sm },
  toastText: { ...typography.subhead, fontWeight: fontWeights.medium, flexShrink: 1 },
  hudBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.12)' },
  hud: { minWidth: 112, maxWidth: 240, borderRadius: radius.xl, padding: spacing.lg + 2, alignItems: 'center', gap: spacing.md },
  hudText: { ...typography.subhead, fontWeight: fontWeights.medium, textAlign: 'center' },
});
