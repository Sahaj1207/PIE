/**
 * Page overview (iOS "Page Thumbnails"): grid of pages for navigation plus page tools for the
 * selected page — rotate, duplicate, insert blank page, move, delete. Thumbnails are rendered
 * lazily (one at a time) from the open revision.
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../../ui/ThemeProvider';
import { BarButton, BottomSheet, Toolbar, ToolbarItem } from '../../../ui/controls';
import { haptic } from '../../../ui/haptics';
import { PdfDocumentOperation, PdfThumbnail, renderPdfThumbnail } from '../pdfDocumentOperations';
import { fontWeights, radius, spacing, typography } from '../../../constants/theme';

/** Sequential thumbnail queue: avoids flooding the native renderer. */
function createThumbnailQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };
}

const PageThumb: React.FC<{
  docHandle: number;
  revisionKey: string;
  pageIndex: number;
  width: number;
  selected: boolean;
  current: boolean;
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  cache: Map<string, PdfThumbnail | null>;
  onPress: () => void;
  onLongPress: () => void;
}> = memo(({ docHandle, revisionKey, pageIndex, width, selected, current, enqueue, cache, onPress, onLongPress }) => {
  const { colors } = useTheme();
  const key = `${revisionKey}:${pageIndex}`;
  const [thumb, setThumb] = useState<PdfThumbnail | null | undefined>(cache.get(key));

  useEffect(() => {
    if (cache.has(key)) {
      setThumb(cache.get(key));
      return;
    }
    let alive = true;
    enqueue(() => renderPdfThumbnail(docHandle, pageIndex, 280)).then((t) => {
      cache.set(key, t);
      if (alive) setThumb(t);
    });
    return () => {
      alive = false;
    };
  }, [key, docHandle, pageIndex, enqueue, cache]);

  const aspect = thumb ? thumb.height / Math.max(1, thumb.width) : 1.3;
  const boxH = width * 1.3;
  const imgW = aspect > 1.3 ? boxH / aspect : width;
  const imgH = aspect > 1.3 ? boxH : width * aspect;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`Page ${pageIndex + 1}`}
      accessibilityState={{ selected }}
      style={[styles.thumbCell, { width }]}>
      <View style={[styles.thumbBox, { height: boxH }]}>
        <View
          style={[
            styles.thumbPage,
            { width: imgW, height: imgH, borderColor: selected ? colors.primary : colors.separator, borderWidth: selected ? 3 : StyleSheet.hairlineWidth },
          ]}>
          {thumb ? (
            <Image source={{ uri: thumb.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
          ) : (
            <ActivityIndicator color={colors.textMuted} />
          )}
        </View>
      </View>
      <View style={[styles.pageLabel, current && { backgroundColor: colors.primary }]}>
        <Text style={[styles.pageLabelText, { color: current ? '#FFFFFF' : colors.textSecondary }]}>{pageIndex + 1}</Text>
      </View>
    </Pressable>
  );
});

export interface PdfPagesSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly docHandle: number | null;
  /** Changes whenever the open revision changes (invalidates thumbnails). */
  readonly revisionKey: string;
  readonly pageCount: number;
  readonly currentPage: number;
  readonly busy: boolean;
  readonly onGoToPage: (pageIndex: number) => void;
  readonly onApply: (op: PdfDocumentOperation, description: string) => Promise<boolean>;
}

export const PdfPagesSheet: React.FC<PdfPagesSheetProps> = ({
  visible,
  onClose,
  docHandle,
  revisionKey,
  pageCount,
  currentPage,
  busy,
  onGoToPage,
  onApply,
}) => {
  const { width } = useWindowDimensions();
  const [selected, setSelected] = useState<number>(currentPage);
  const enqueue = useRef(createThumbnailQueue()).current;
  const cache = useRef(new Map<string, PdfThumbnail | null>()).current;

  useEffect(() => {
    if (visible) setSelected(currentPage);
  }, [visible, currentPage]);

  useEffect(() => {
    // Thumbnails of other revisions are never shown again.
    for (const k of [...cache.keys()]) if (!k.startsWith(`${revisionKey}:`)) cache.delete(k);
  }, [revisionKey, cache]);

  useEffect(() => {
    if (selected >= pageCount) setSelected(Math.max(0, pageCount - 1));
  }, [pageCount, selected]);

  const columns = width >= 700 ? 5 : width >= 500 ? 4 : 3;
  const gap = spacing.md;
  const cellW = Math.floor((width - spacing.lg * 2 - gap * (columns - 1)) / columns);

  const apply = useCallback(
    async (op: PdfDocumentOperation, description: string, nextSelection?: number) => {
      const ok = await onApply(op, description);
      if (ok && nextSelection !== undefined) setSelected(nextSelection);
    },
    [onApply],
  );

  const items: ToolbarItem[] = [
    { key: 'rl', icon: 'rotateLeft', label: 'Left', disabled: busy, onPress: () => apply({ type: 'rotatePage', pageIndex: selected, quarterTurns: 3 }, 'Rotated') },
    { key: 'rr', icon: 'rotateRight', label: 'Right', disabled: busy, onPress: () => apply({ type: 'rotatePage', pageIndex: selected, quarterTurns: 1 }, 'Rotated') },
    { key: 'dup', icon: 'pages', label: 'Duplicate', disabled: busy, onPress: () => apply({ type: 'duplicatePage', pageIndex: selected }, 'Page duplicated', selected + 1) },
    { key: 'ins', icon: 'docPlus', label: 'Blank', disabled: busy, onPress: () => apply({ type: 'insertBlankPage', pageIndex: selected + 1 }, 'Blank page added', selected + 1) },
    {
      key: 'up',
      icon: 'arrowUp',
      label: 'Earlier',
      disabled: busy || selected <= 0,
      onPress: () => apply({ type: 'movePage', pageIndex: selected, toIndex: selected - 1 }, 'Page moved', selected - 1),
    },
    {
      key: 'down',
      icon: 'arrowDown',
      label: 'Later',
      disabled: busy || selected >= pageCount - 1,
      onPress: () => apply({ type: 'movePage', pageIndex: selected, toIndex: selected + 1 }, 'Page moved', selected + 1),
    },
    {
      key: 'del',
      icon: 'trash',
      label: 'Delete',
      destructive: true,
      disabled: busy || pageCount <= 1,
      onPress: () => apply({ type: 'deletePage', pageIndex: selected }, 'Page deleted', Math.max(0, selected - 1)),
    },
  ];

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={`${pageCount} ${pageCount === 1 ? 'Page' : 'Pages'}`}
      heightFraction={0.9}
      scroll={false}
      left={busy ? <ActivityIndicator style={{ marginLeft: spacing.md }} /> : undefined}
      right={<BarButton label="Done" prominent onPress={onClose} />}>
      <View style={{ flex: 1 }}>
        {docHandle !== null && (
          <FlatList
            key={`cols-${columns}`}
            data={Array.from({ length: pageCount }, (_, i) => i)}
            keyExtractor={(i) => String(i)}
            numColumns={columns}
            columnWrapperStyle={{ gap, paddingHorizontal: spacing.lg }}
            contentContainerStyle={{ paddingVertical: spacing.md, gap: spacing.lg }}
            initialScrollIndex={undefined}
            renderItem={({ item }) => (
              <PageThumb
                docHandle={docHandle}
                revisionKey={revisionKey}
                pageIndex={item}
                width={cellW}
                selected={item === selected}
                current={item === currentPage}
                enqueue={enqueue}
                cache={cache}
                onPress={() => {
                  if (item === selected) {
                    onGoToPage(item);
                    onClose();
                  } else {
                    haptic('selection');
                    setSelected(item);
                  }
                }}
                onLongPress={() => {
                  haptic('medium');
                  setSelected(item);
                }}
              />
            )}
          />
        )}
        <Text style={styles.hint}>Tap a page to select it, tap again to open it.</Text>
        <Toolbar items={items} />
      </View>
    </BottomSheet>
  );
};

const styles = StyleSheet.create({
  thumbCell: { alignItems: 'center' },
  thumbBox: { width: '100%', alignItems: 'center', justifyContent: 'flex-end' },
  thumbPage: {
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  pageLabel: { marginTop: 6, minWidth: 26, paddingHorizontal: 6, height: 20, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  pageLabelText: { ...typography.caption, fontWeight: fontWeights.semibold },
  hint: { textAlign: 'center', ...typography.caption, color: '#8E8E93', marginVertical: 6 },
});
