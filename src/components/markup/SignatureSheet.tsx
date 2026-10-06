/**
 * Signatures: pick a saved signature or draw a new one (iOS "Add Signature"). Drawing happens
 * on a pad with one finger; strokes are smoothed with the shared ink geometry and stored
 * locally (never uploaded).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../ui/ThemeProvider';
import { BarButton, BottomSheet, EmptyState, PillButton } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { showAlert } from '../../ui/overlays';
import { haptic } from '../../ui/haptics';
import { InkLayer } from './InkLayer';
import { PathCommand, Point, smoothStroke } from '../../features/markup/inkPath';
import { SavedSignature, createSignature, signatureStore } from '../../features/markup/signatureStore';
import { radius, spacing, typography } from '../../constants/theme';

const PAD_STROKE = 3;

export const SignaturePad: React.FC<{ visible: boolean; onCancel: () => void; onDone: (sig: SavedSignature) => void }> = ({
  visible,
  onCancel,
  onDone,
}) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [strokes, setStrokes] = useState<PathCommand[][]>([]);
  const [current, setCurrent] = useState<Point[]>([]);
  const currentRef = useRef<Point[]>([]);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (visible) {
      setStrokes([]);
      setCurrent([]);
      currentRef.current = [];
    }
  }, [visible]);

  const flush = useCallback(() => {
    frame.current = null;
    setCurrent([...currentRef.current]);
  }, []);

  const start = useCallback((x: number, y: number) => {
    currentRef.current = [{ x, y }];
    setCurrent([{ x, y }]);
  }, []);
  const move = useCallback(
    (x: number, y: number) => {
      currentRef.current.push({ x, y });
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    },
    [flush],
  );
  const end = useCallback(() => {
    const pts = currentRef.current;
    currentRef.current = [];
    setCurrent([]);
    const cmds = smoothStroke(pts, 0.8);
    if (cmds.length > 0) setStrokes((s) => [...s, cmds]);
  }, []);

  const pan = Gesture.Pan()
    .minDistance(0)
    .maxPointers(1)
    .onStart((e) => {
      'worklet';
      runOnJS(start)(e.x, e.y);
    })
    .onUpdate((e) => {
      'worklet';
      runOnJS(move)(e.x, e.y);
    })
    .onEnd(() => {
      'worklet';
      runOnJS(end)();
    });

  const padWidth = width - spacing.lg * 2;
  const padHeight = Math.min(height * 0.42, padWidth * 0.62);

  const save = async () => {
    const sig = createSignature(strokes, PAD_STROKE);
    if (!sig) {
      showAlert('Sign Above', 'Draw your signature on the line first.');
      return;
    }
    try {
      await signatureStore.add(sig);
    } catch {
      // Still usable for this document even if it could not be stored.
    }
    haptic('success');
    onDone(sig);
  };

  const items = [
    ...strokes.map((cmds, i) => ({ key: `s${i}`, commands: cmds, color: '#1C1C1E', width: PAD_STROKE })),
    ...(current.length > 0 ? [{ key: 'live', commands: smoothStroke(current, 0.5), color: '#1C1C1E', width: PAD_STROKE }] : []),
  ];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onCancel} statusBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={[styles.padRoot, { backgroundColor: colors.groupedBackground, paddingTop: insets.top, paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.padHeader}>
            <BarButton label="Cancel" onPress={onCancel} />
            <Text style={[styles.padTitle, { color: colors.textPrimary }]}>New Signature</Text>
            <BarButton label="Done" prominent onPress={save} disabled={strokes.length === 0} />
          </View>
          <View style={styles.padCenter}>
            <GestureDetector gesture={pan}>
              <View style={[styles.pad, { width: padWidth, height: padHeight }]} accessibilityLabel="Signature pad. Draw with one finger.">
                <View style={[styles.signLine, { top: padHeight * 0.72 }]} />
                <Text style={[styles.signX, { top: padHeight * 0.72 - 26 }]}>✕</Text>
                <View style={StyleSheet.absoluteFill} pointerEvents="none">
                  <InkLayer items={items} width={padWidth} height={padHeight} />
                </View>
              </View>
            </GestureDetector>
            <Text style={[styles.padHint, { color: colors.textSecondary }]}>Sign with your finger above the line</Text>
            <PillButton
              label="Clear"
              tone="secondary"
              icon="trash"
              onPress={() => setStrokes([])}
              disabled={strokes.length === 0}
              style={{ marginTop: spacing.lg }}
            />
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
};

export const SignatureSheet: React.FC<{
  visible: boolean;
  onClose: () => void;
  onChoose: (signature: SavedSignature) => void;
}> = ({ visible, onClose, onChoose }) => {
  const { colors } = useTheme();
  const [signatures, setSignatures] = useState<SavedSignature[]>([]);
  const [padVisible, setPadVisible] = useState(false);

  useEffect(() => {
    if (visible) signatureStore.list().then(setSignatures).catch(() => setSignatures([]));
  }, [visible]);

  const remove = (sig: SavedSignature) => {
    showAlert('Delete Signature?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          signatureStore.remove(sig.id).then(setSignatures).catch(() => {});
        },
      },
    ]);
  };

  return (
    <>
      <BottomSheet
        visible={visible && !padVisible}
        onClose={onClose}
        title="Signatures"
        left={<BarButton label="Cancel" onPress={onClose} />}
        right={<BarButton icon="plus" onPress={() => setPadVisible(true)} accessibilityLabel="Add signature" />}>
        <View style={styles.sheetBody}>
          {signatures.length === 0 ? (
            <EmptyState
              icon="signature"
              title="No Signatures"
              message="Add your signature once and place it on any document."
              action={<PillButton label="Add Signature" icon="plus" onPress={() => setPadVisible(true)} style={{ marginTop: spacing.md }} />}
            />
          ) : (
            signatures.map((sig) => {
              const previewH = 72;
              const s = Math.min(previewH / sig.height, 260 / sig.width);
              return (
                <Pressable
                  key={sig.id}
                  onPress={() => onChoose(sig)}
                  onLongPress={() => remove(sig)}
                  accessibilityRole="button"
                  accessibilityLabel="Use this signature"
                  accessibilityHint="Long press to delete"
                  style={({ pressed }) => [styles.sigCard, { backgroundColor: '#FFFFFF' }, pressed && { opacity: 0.7 }]}>
                  <InkLayer
                    items={sig.strokes.map((c, i) => ({ key: `${sig.id}${i}`, commands: c, color: '#1C1C1E', width: sig.strokeRatio * sig.height }))}
                    width={sig.width * s}
                    height={sig.height * s}
                    scale={s}
                  />
                  <Pressable onPress={() => remove(sig)} hitSlop={10} style={styles.sigDelete} accessibilityLabel="Delete signature">
                    <Icon name="closeCircle" size={22} color="#C7C7CC" />
                  </Pressable>
                </Pressable>
              );
            })
          )}
          {signatures.length > 0 && (
            <Text style={[styles.hint, { color: colors.textSecondary }]}>Tap a signature to place it. Long press to delete.</Text>
          )}
        </View>
      </BottomSheet>
      <SignaturePad
        visible={padVisible}
        onCancel={() => setPadVisible(false)}
        onDone={(sig) => {
          setPadVisible(false);
          onChoose(sig);
        }}
      />
    </>
  );
};

const styles = StyleSheet.create({
  padRoot: { flex: 1 },
  padHeader: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.sm },
  padTitle: { ...typography.headline },
  padCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.lg,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  signLine: { position: 'absolute', left: 24, right: 24, height: 1, backgroundColor: '#C7C7CC' },
  signX: { position: 'absolute', left: 26, fontSize: 18, color: '#8E8E93' },
  padHint: { marginTop: spacing.md, ...typography.footnote },
  sheetBody: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md },
  sigCard: {
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 104,
  },
  sigDelete: { position: 'absolute', top: 8, right: 8 },
  hint: { ...typography.caption, textAlign: 'center', marginTop: spacing.xs },
});
