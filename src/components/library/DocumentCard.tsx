/**
 * Library item: grid card (thumbnail + title + date) or list row. Thumbnails load lazily
 * (image preview or rendered first PDF page).
 */
import React, { memo, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { DocumentSummary } from '../../features/documents/types';
import { displayTitle, formatRelativeDate, getLibraryThumbnail } from '../../features/library/libraryService';
import { useTheme } from '../../ui/ThemeProvider';
import { Icon } from '../../ui/Icon';
import { ScalePressable } from '../../ui/controls';
import { haptic } from '../../ui/haptics';
import { fontWeights, radius, spacing, typography } from '../../constants/theme';

export function useDocumentThumbnail(item: DocumentSummary): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getLibraryThumbnail(item)
      .then((u) => {
        if (alive) setUri(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [item]);
  return uri;
}

function subtitleFor(item: DocumentSummary): string {
  const date = formatRelativeDate(item.metadata.updatedAt);
  if (item.metadata.kind === 'pdf' && item.metadata.pageCount > 0) {
    return `${date} · ${item.metadata.pageCount} ${item.metadata.pageCount === 1 ? 'page' : 'pages'}`;
  }
  return date;
}

const Thumbnail: React.FC<{ item: DocumentSummary; style: object; iconSize: number }> = ({ item, style, iconSize }) => {
  const { colors } = useTheme();
  const uri = useDocumentThumbnail(item);
  const isPdf = item.metadata.kind === 'pdf';
  return (
    <View style={[style, { backgroundColor: isPdf ? colors.canvasPage : colors.fillTertiary }]}>
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode={isPdf ? 'contain' : 'cover'}
          resizeMethod="resize"
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Icon name={isPdf ? 'docText' : 'photo'} size={iconSize} color={isPdf ? colors.pdfTint : colors.imageTint} weight={1.4} />
      )}
    </View>
  );
};

const KindBadge: React.FC<{ kind: 'pdf' | 'image' }> = ({ kind }) => {
  const { colors } = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: kind === 'pdf' ? colors.pdfTint : colors.imageTint }]}>
      <Text style={styles.badgeText}>{kind === 'pdf' ? 'PDF' : 'IMG'}</Text>
    </View>
  );
};

interface CardProps {
  readonly item: DocumentSummary;
  readonly width: number;
  readonly busy?: boolean;
  readonly onOpen: (item: DocumentSummary) => void;
  readonly onMore: (item: DocumentSummary) => void;
}

export const DocumentGridCard: React.FC<CardProps> = memo(({ item, width, busy, onOpen, onMore }) => {
  const { colors } = useTheme();
  const title = displayTitle(item.metadata.title);
  return (
    <View style={{ width }}>
      <ScalePressable
        onPress={() => onOpen(item)}
        onLongPress={() => {
          haptic('medium');
          onMore(item);
        }}
        delayLongPress={350}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.metadata.title}`}
        accessibilityHint="Long press for more actions"
        accessibilityActions={[{ name: 'longpress', label: 'More actions' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'longpress') onMore(item);
        }}
        style={[styles.cardThumbWrap, { height: width * 1.3, shadowColor: '#000' }, busy && { opacity: 0.4 }]}>
        <Thumbnail item={item} style={[styles.cardThumb, { borderColor: colors.separator }]} iconSize={40} />
        <View style={styles.badgeCorner}>
          <KindBadge kind={item.metadata.kind} />
        </View>
      </ScalePressable>
      <View style={styles.cardInfoRow}>
        <View style={styles.cardText}>
          <Text numberOfLines={2} style={[styles.cardTitle, { color: colors.textPrimary }]}>
            {title}
          </Text>
          <Text numberOfLines={1} style={[styles.cardSubtitle, { color: colors.textSecondary }]}>
            {subtitleFor(item)}
          </Text>
        </View>
        <Pressable
          onPress={() => onMore(item)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`More actions for ${item.metadata.title}`}
          style={({ pressed }) => [styles.moreBtn, pressed && { opacity: 0.5 }]}>
          <Icon name="moreCircle" size={20} color={colors.textMuted} />
        </Pressable>
      </View>
    </View>
  );
});

/** Left edge of the list row text (row padding + thumbnail + gap): dividers start here. */
export const LIST_ROW_TEXT_INSET = spacing.lg + 40 + spacing.md;

export const DocumentListRow: React.FC<Omit<CardProps, 'width'>> = memo(({ item, busy, onOpen, onMore }) => {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => onOpen(item)}
      onLongPress={() => {
        haptic('medium');
        onMore(item);
      }}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.metadata.title}`}
      accessibilityHint="Long press for more actions"
      style={({ pressed }) => [styles.listRow, pressed && { backgroundColor: colors.cellPressed }, busy && { opacity: 0.4 }]}>
      <Thumbnail item={item} style={[styles.listThumb, { borderColor: colors.separator }]} iconSize={24} />
      <View style={styles.listText}>
        <Text numberOfLines={1} style={[styles.listTitle, { color: colors.textPrimary }]}>
          {displayTitle(item.metadata.title)}
        </Text>
        <View style={styles.listSubRow}>
          <KindBadge kind={item.metadata.kind} />
          <Text numberOfLines={1} style={[styles.cardSubtitle, { color: colors.textSecondary, marginLeft: 6 }]}>
            {subtitleFor(item)}
          </Text>
        </View>
      </View>
      <Pressable
        onPress={() => onMore(item)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`More actions for ${item.metadata.title}`}
        style={({ pressed }) => [styles.listMoreBtn, pressed && { opacity: 0.5 }]}>
        <Icon name="ellipsis" size={22} color={colors.primary} />
      </Pressable>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  cardThumbWrap: {
    borderRadius: radius.md,
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  cardThumb: {
    flex: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  badgeCorner: { position: 'absolute', left: 8, bottom: 8 },
  badge: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1.5 },
  badgeText: { color: '#FFFFFF', fontSize: 9, lineHeight: 12, fontWeight: fontWeights.bold, letterSpacing: 0.5 },
  cardInfoRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.sm },
  cardText: { flex: 1, minWidth: 0 },
  cardTitle: { ...typography.footnote, fontWeight: fontWeights.semibold },
  cardSubtitle: { ...typography.caption, marginTop: 1 },
  moreBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginTop: -7, marginRight: -8 },
  listRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.sm, paddingVertical: 10, gap: spacing.md, minHeight: 70 },
  listMoreBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  listThumb: {
    width: 40,
    height: 50,
    borderRadius: 6,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  listText: { flex: 1, minWidth: 0 },
  listTitle: { ...typography.bodyMedium, fontWeight: fontWeights.medium },
  listSubRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
});
