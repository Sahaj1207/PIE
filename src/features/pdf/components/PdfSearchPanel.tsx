/**
 * Find in document: search field in the navigation area plus a result list (page + snippet
 * with the match in bold). Results come from PDFium's text search of the open revision.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../../ui/ThemeProvider';
import { BarButton, SearchField } from '../../../ui/controls';
import { PdfSearchResponse, PdfSearchResult, searchPdf } from '../pdfDocumentOperations';
import { mergeSearchResults } from '../pdfOcr';
import { fontWeights, spacing, typography } from '../../../constants/theme';

export interface PdfSearchPanelProps {
  readonly docHandle: number | null;
  readonly revisionKey: string;
  readonly activeIndex: number;
  readonly onResults: (results: readonly PdfSearchResult[]) => void;
  readonly onSelectResult: (index: number) => void;
  readonly onClose: () => void;
  /** Collapsed: only the bar with result navigation (results drawn on the page). */
  readonly collapsed: boolean;
  readonly onExpand: () => void;
  /** Additional matches (e.g. text recognised on scanned pages), merged with PDFium's. */
  readonly extraSearch?: (query: string) => readonly PdfSearchResult[];
}

export const PdfSearchBar: React.FC<PdfSearchPanelProps> = ({
  docHandle,
  revisionKey,
  activeIndex,
  onResults,
  onSelectResult,
  onClose,
  collapsed,
  onExpand,
  extraSearch,
}) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<PdfSearchResponse>({ results: [], truncated: false });
  const [searching, setSearching] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const gen = ++generation.current;
    if (!q || docHandle === null) {
      setResponse({ results: [], truncated: false });
      onResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      searchPdf(docHandle, q)
        .then((r) => {
          if (gen !== generation.current) return;
          const extra = extraSearch ? extraSearch(q) : [];
          const merged: PdfSearchResponse = extra.length > 0 ? { results: mergeSearchResults(r.results, extra), truncated: r.truncated } : r;
          setResponse(merged);
          onResults(merged.results);
        })
        .catch(() => {
          if (gen === generation.current) {
            setResponse({ results: [], truncated: false });
            onResults([]);
          }
        })
        .finally(() => {
          if (gen === generation.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
    // revisionKey: search again when the document changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, docHandle, revisionKey]);

  const count = response.results.length;
  const go = (delta: number) => {
    if (count === 0) return;
    onSelectResult((activeIndex + delta + count) % count);
  };

  return (
    <View style={{ paddingTop: insets.top, backgroundColor: colors.bar, borderBottomColor: colors.separator, borderBottomWidth: StyleSheet.hairlineWidth }}>
      <View style={styles.row}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Find in document" autoFocus style={styles.field} onSubmit={() => go(1)} />
        <BarButton label="Done" prominent onPress={onClose} />
      </View>
      {query.trim().length > 0 && (
        <View style={styles.statusRow}>
          {searching ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : (
            <Pressable onPress={onExpand} accessibilityRole="button" accessibilityLabel="Show all results">
              <Text style={[styles.status, { color: colors.textSecondary }]}>
                {count === 0
                  ? 'No matches'
                  : `${Math.min(activeIndex + 1, count)} of ${count}${response.truncated ? '+' : ''} ${count === 1 ? 'match' : 'matches'}${collapsed ? ' · Show List' : ''}`}
              </Text>
            </Pressable>
          )}
          <View style={styles.nav}>
            <BarButton icon="chevronUp" onPress={() => go(-1)} disabled={count === 0} accessibilityLabel="Previous match" iconSize={20} />
            <BarButton icon="chevronDown" onPress={() => go(1)} disabled={count === 0} accessibilityLabel="Next match" iconSize={20} />
          </View>
        </View>
      )}
    </View>
  );
};

/** Expanded result list (shown under the search bar). */
export const PdfSearchResultsList: React.FC<{
  results: readonly PdfSearchResult[];
  activeIndex: number;
  onSelect: (index: number) => void;
}> = ({ results, activeIndex, onSelect }) => {
  const { colors } = useTheme();
  return (
    <FlatList
      data={results as PdfSearchResult[]}
      keyExtractor={(r, i) => `${r.pageIndex}:${r.charIndex}:${i}`}
      style={{ backgroundColor: colors.groupedBackground }}
      keyboardShouldPersistTaps="handled"
      ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: colors.separator }]} />}
      renderItem={({ item, index }) => {
        const before = item.snippet.slice(0, item.matchStart);
        const match = item.snippet.slice(item.matchStart, item.matchStart + item.matchLength);
        const after = item.snippet.slice(item.matchStart + item.matchLength);
        return (
          <Pressable
            onPress={() => onSelect(index)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.result, { backgroundColor: index === activeIndex ? colors.primarySubtle : colors.cell }, pressed && { backgroundColor: colors.cellPressed }]}>
            <Text style={[styles.resultPage, { color: colors.textSecondary }]}>Page {item.pageIndex + 1}</Text>
            <Text style={[styles.snippet, { color: colors.textPrimary }]} numberOfLines={2}>
              {before.trimStart()}
              <Text style={styles.match}>{match}</Text>
              {after}
            </Text>
          </Pressable>
        );
      }}
    />
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.md, paddingRight: spacing.xs, paddingVertical: 6, gap: spacing.xs },
  field: { flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: 2, minHeight: 34 },
  status: { ...typography.footnote },
  nav: { flexDirection: 'row' },
  result: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  resultPage: { ...typography.caption, fontWeight: fontWeights.semibold, marginBottom: 2 },
  snippet: { ...typography.subhead },
  match: { fontWeight: fontWeights.bold },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: spacing.lg },
});
