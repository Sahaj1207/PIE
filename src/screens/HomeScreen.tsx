import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { HomeScreenNavigationProp } from '../navigation/types';
import { DocumentSummary } from '../features/documents/types';
import { documentStorage } from '../storage';
import { defaultPdfiumEngine } from '../features/pdf/pdfiumEngine';
import { describeLibraryDeleteError } from '../features/pdf/pdfLibrary';
import { describePdfOutputError } from '../features/pdf/pdfOutputService';
import { pickPdfFiles } from '../features/pdf/pdfDocumentOperations';
import {
  createDocumentFromPickedImage,
  pickImageFromFiles,
  pickImageFromLibrary,
  pickImagesFromLibrary,
  takePhotoWithCamera,
} from '../features/image/importService';
import { defaultExportEngine } from '../features/export';
import {
  LibraryFilter,
  createPdfFromImages,
  deleteLibraryDocument,
  describeLibraryError,
  displayTitle,
  duplicateDocument,
  filterAndSortDocuments,
  formatRelativeDate,
  mergePdfDocuments,
  renameDocument,
  validateDocumentTitle,
} from '../features/library/libraryService';
import { appSettings, useAppSettings } from '../settings/appSettings';
import { useTheme } from '../ui/ThemeProvider';
import { Icon } from '../ui/Icon';
import { IconName } from '../ui/icons';
import {
  BarButton,
  BottomSheet,
  EmptyState,
  ListRow,
  ListSection,
  PillButton,
  ScalePressable,
  SearchField,
  SegmentedControl,
} from '../ui/controls';
import { showActionSheet, showAlert, showPrompt, showToast, withProgress } from '../ui/overlays';
import { DocumentGridCard, DocumentListRow, LIST_ROW_TEXT_INSET } from '../components/library/DocumentCard';
import { fontWeights, radius, spacing, typography } from '../constants/theme';

function isTestEnv(): boolean {
  return typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test';
}

function defaultScanTitle(prefix: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${prefix} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

interface QuickAction {
  readonly key: string;
  readonly label: string;
  /** Full description for screen readers (the visible label is kept short to fit the card). */
  readonly accessibilityLabel?: string;
  readonly caption: string;
  readonly icon: IconName;
  readonly tint: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
}

export const HomeScreen: React.FC = () => {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<HomeScreenNavigationProp>();
  const isFocused = useIsFocused();
  const { colors } = useTheme();
  const settings = useAppSettings();
  const { width } = useWindowDimensions();

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importingImage, setImportingImage] = useState(false);
  const [pickingPdf, setPickingPdf] = useState(false);
  const [infoItem, setInfoItem] = useState<DocumentSummary | null>(null);
  const scrollY = useRef(new Animated.Value(0)).current;

  const loadDocuments = useCallback(async () => {
    try {
      const list = await documentStorage.listDocuments();
      setDocuments(list);
    } catch {
      // A failed listing keeps the current list.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (isFocused) loadDocuments();
  }, [isFocused, loadDocuments]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadDocuments();
    setRefreshing(false);
  }, [loadDocuments]);

  const visible = useMemo(
    () => filterAndSortDocuments(documents, query, filter, settings.librarySort),
    [documents, query, filter, settings.librarySort],
  );

  // -------------------------------------------------------------------------
  // Open / import
  // -------------------------------------------------------------------------

  const openDocument = useCallback(
    (item: DocumentSummary) => {
      if (item.metadata.kind === 'pdf') {
        navigation.navigate('PdfEditor', {
          pdfPath: item.metadata.sourceUri,
          fileName: item.metadata.title,
          documentId: item.id,
        });
      } else {
        navigation.navigate('Editor', { documentId: item.id });
      }
    },
    [navigation],
  );

  const executePdfPicker = async () => {
    if (pickingPdf) return;
    setPickingPdf(true);
    try {
      if (typeof defaultPdfiumEngine.pickPdfDocument !== 'function') {
        navigation.navigate('PdfEditor');
        return;
      }
      const picked = await defaultPdfiumEngine.pickPdfDocument();
      if (!picked) {
        console.log('[PHASE1_PDF] PICKER_RESULT: cancelled');
        return;
      }
      console.log('[PHASE1_PDF] PICKER_RESULT: ' + picked.fileName);
      navigation.navigate('PdfEditor', { pdfPath: picked.filePath, fileName: picked.fileName });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Unable to Open PDF', msg);
    } finally {
      setPickingPdf(false);
    }
  };

  const executeImagePicker = async (source: 'photos' | 'files' | 'camera') => {
    if (importingImage) return;
    setImportingImage(true);
    try {
      const picked =
        source === 'photos'
          ? await pickImageFromLibrary()
          : source === 'files'
            ? await pickImageFromFiles()
            : await takePhotoWithCamera();
      if (!picked) {
        console.log('[PHASE1_IMAGE] PICKER_RESULT: cancelled');
        return;
      }
      console.log('[PHASE1_IMAGE] PICKER_RESULT: ' + picked.fileName);
      const doc = await createDocumentFromPickedImage(picked);
      await loadDocuments();
      navigation.navigate('Editor', { documentId: doc.id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showAlert('Unable to Open Image', message);
    } finally {
      setImportingImage(false);
    }
  };

  // Primary action: Edit PDF (system document picker; direct navigation in tests)
  const handleEditPdf = async () => {
    if (isTestEnv()) {
      navigation.navigate('PdfEditor');
      return;
    }
    await executePdfPicker();
  };

  // Primary action: Edit Image (source sheet in the app; photo library in tests)
  const handleEditImage = async () => {
    if (isTestEnv()) {
      await executeImagePicker('photos');
      return;
    }
    showActionSheet({
      title: 'Edit an Image',
      options: [
        { label: 'Photo Library', icon: 'photo', onPress: () => executeImagePicker('photos') },
        { label: 'Take Photo', icon: 'camera', onPress: () => executeImagePicker('camera') },
        { label: 'Choose File', icon: 'folder', onPress: () => executeImagePicker('files') },
      ],
    });
  };

  const handleImagesToPdf = async () => {
    try {
      const uris = await pickImagesFromLibrary(100);
      if (uris.length === 0) return;
      showPrompt({
        title: 'New PDF',
        message: `${uris.length} ${uris.length === 1 ? 'image' : 'images'} will become ${uris.length === 1 ? 'a page' : 'pages'}.`,
        defaultValue: defaultScanTitle('Scan'),
        confirmLabel: 'Create',
        validate: validateDocumentTitle,
        onConfirm: async (title) => {
          try {
            const doc = await withProgress('Creating PDF…', () => createPdfFromImages(uris, title, 'fit'));
            showToast('PDF created', { tone: 'success' });
            await loadDocuments();
            openDocument({ id: doc.id, metadata: doc.metadata });
          } catch (err) {
            showAlert('Could Not Create PDF', describeLibraryError(err));
          }
        },
      });
    } catch (err) {
      showAlert('Could Not Create PDF', describeLibraryError(err));
    }
  };

  const handleMergePdfs = async () => {
    try {
      const picked = await pickPdfFiles();
      if (picked.length === 0) return;
      if (picked.length < 2) {
        showAlert('Choose More PDFs', 'Select two or more PDFs to combine them into one.');
        return;
      }
      showPrompt({
        title: 'Merge PDFs',
        message: `${picked.length} PDFs will be combined in the order you selected them.`,
        defaultValue: defaultScanTitle('Merged'),
        confirmLabel: 'Merge',
        validate: validateDocumentTitle,
        onConfirm: async (title) => {
          try {
            const doc = await withProgress('Merging PDFs…', () =>
              mergePdfDocuments(picked.map((p) => p.filePath), title),
            );
            defaultPdfiumEngine.purgeImportCache([]).catch(() => 0);
            showToast('PDFs merged', { tone: 'success' });
            await loadDocuments();
            openDocument({ id: doc.id, metadata: doc.metadata });
          } catch (err) {
            showAlert('Could Not Merge', describeLibraryError(err));
          }
        },
      });
    } catch (err) {
      showAlert('Could Not Merge', describeLibraryError(err));
    }
  };

  const handleNew = () => {
    showActionSheet({
      title: 'Create or Open',
      options: [
        { label: 'Open PDF', icon: 'docText', onPress: () => executePdfPicker() },
        { label: 'Image from Photos', icon: 'photo', onPress: () => executeImagePicker('photos') },
        { label: 'Take Photo', icon: 'camera', onPress: () => executeImagePicker('camera') },
        { label: 'Image from Files', icon: 'folder', onPress: () => executeImagePicker('files') },
        { label: 'Create PDF from Photos', icon: 'pages', onPress: () => handleImagesToPdf() },
        { label: 'Merge PDFs', icon: 'merge', onPress: () => handleMergePdfs() },
      ],
    });
  };

  // -------------------------------------------------------------------------
  // Item actions
  // -------------------------------------------------------------------------

  const runItemTask = useCallback(
    async (item: DocumentSummary, task: () => Promise<void>, failureTitle: string) => {
      setBusyId(item.id);
      try {
        await task();
      } catch (err) {
        showAlert(failureTitle, describeLibraryError(err));
      } finally {
        setBusyId(null);
        loadDocuments();
      }
    },
    [loadDocuments],
  );

  const renameItem = useCallback(
    (item: DocumentSummary) => {
      showPrompt({
        title: 'Rename',
        defaultValue: displayTitle(item.metadata.title),
        confirmLabel: 'Save',
        validate: validateDocumentTitle,
        onConfirm: (title) =>
          runItemTask(item, async () => {
            await renameDocument(item.id, title);
            showToast('Renamed', { tone: 'success' });
          }, 'Unable to Rename'),
      });
    },
    [runItemTask],
  );

  const shareItem = useCallback(
    (item: DocumentSummary) =>
      runItemTask(item, async () => {
        if (item.metadata.kind === 'pdf') {
          try {
            await defaultPdfiumEngine.sharePdfFile(item.metadata.sourceUri, item.metadata.title, 'Share PDF');
          } catch (err) {
            throw new Error(describePdfOutputError(err));
          }
          return;
        }
        const doc = await documentStorage.getDocument(item.id);
        if (!doc) throw new Error('The image could not be loaded.');
        const result = await withProgress('Preparing image…', () =>
          defaultExportEngine.exportDocument(doc, {
            format: settings.defaultImageExportFormat,
            quality: Math.round(settings.defaultImageExportQuality * 100),
            destination: 'file',
            displayName: doc.metadata.title,
          }),
        );
        await defaultExportEngine.shareExportedFile(result.destinationUri, result.format, 'Share Image');
      }, 'Unable to Share'),
    [runItemTask, settings.defaultImageExportFormat, settings.defaultImageExportQuality],
  );

  const deleteItem = useCallback(
    (item: DocumentSummary) => {
      showAlert(
        `Delete “${displayTitle(item.metadata.title)}”?`,
        item.metadata.kind === 'pdf'
          ? 'This PDF and its saved versions will be removed from this device. Copies you saved elsewhere or shared are not affected.'
          : 'This image and its edits will be removed from this device. The original photo in your library is not affected.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              setBusyId(item.id);
              deleteLibraryDocument(item)
                .then(() => {
                  setDocuments((list) => list.filter((d) => d.id !== item.id));
                  showToast('Deleted');
                })
                .catch((err) =>
                  showAlert('Unable to Delete', item.metadata.kind === 'pdf' ? describeLibraryDeleteError(err) : describeLibraryError(err)),
                )
                .finally(() => {
                  setBusyId(null);
                  loadDocuments();
                });
            },
          },
        ],
      );
    },
    [loadDocuments],
  );

  const showItemActions = useCallback(
    (item: DocumentSummary) => {
      showActionSheet({
        title: displayTitle(item.metadata.title),
        message: item.metadata.kind === 'pdf' ? 'PDF document' : 'Image',
        options: [
          { label: 'Open', icon: item.metadata.kind === 'pdf' ? 'docText' : 'photo', onPress: () => openDocument(item) },
          { label: 'Rename', icon: 'pencil', onPress: () => renameItem(item) },
          {
            label: 'Duplicate',
            icon: 'pages',
            onPress: () =>
              runItemTask(item, async () => {
                await withProgress('Duplicating…', () => duplicateDocument(item.id));
                showToast('Duplicated', { tone: 'success' });
              }, 'Unable to Duplicate'),
          },
          { label: 'Share', icon: 'share', onPress: () => shareItem(item) },
          { label: 'Info', icon: 'info', onPress: () => setInfoItem(item) },
          { label: 'Delete', icon: 'trash', destructive: true, onPress: () => deleteItem(item) },
        ],
      });
    },
    [openDocument, renameItem, runItemTask, shareItem, deleteItem],
  );

  const showViewOptions = () => {
    showActionSheet({
      title: 'View Options',
      options: [
        { label: 'View as Icons', icon: 'grid', checked: settings.libraryLayout === 'grid', onPress: () => appSettings.update({ libraryLayout: 'grid' }) },
        { label: 'View as List', icon: 'list', checked: settings.libraryLayout === 'list', onPress: () => appSettings.update({ libraryLayout: 'list' }) },
        { label: 'Sort by Date Modified', icon: 'sort', checked: settings.librarySort === 'recent', onPress: () => appSettings.update({ librarySort: 'recent' }) },
        { label: 'Sort by Date Added', icon: 'sort', checked: settings.librarySort === 'created', onPress: () => appSettings.update({ librarySort: 'created' }) },
        { label: 'Sort by Name', icon: 'sort', checked: settings.librarySort === 'name', onPress: () => appSettings.update({ librarySort: 'name' }) },
      ],
    });
  };

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  const horizontalPadding = spacing.lg;
  const columns = width >= 900 ? 5 : width >= 700 ? 4 : width >= 520 ? 3 : 2;
  const gap = spacing.lg;
  const cardWidth = Math.floor((width - horizontalPadding * 2 - gap * (columns - 1)) / columns);
  const grid = settings.libraryLayout === 'grid';

  const quickActions: QuickAction[] = [
    { key: 'pdf', label: 'Edit PDF', caption: 'Open a PDF', icon: 'docText', tint: colors.pdfTint, onPress: handleEditPdf, busy: pickingPdf },
    { key: 'image', label: 'Edit Image', caption: 'Photos & files', icon: 'photo', tint: colors.imageTint, onPress: handleEditImage, busy: importingImage },
    {
      key: 'scan',
      label: 'Create PDF',
      caption: 'From photos',
      accessibilityLabel: 'Images to PDF: create a PDF from photos',
      icon: 'pages',
      tint: colors.primary,
      onPress: handleImagesToPdf,
    },
    { key: 'merge', label: 'Merge PDFs', caption: 'Join PDFs', accessibilityLabel: 'Merge PDFs into one', icon: 'merge', tint: colors.warning, onPress: handleMergePdfs },
  ];

  const titleOpacity = scrollY.interpolate({ inputRange: [30, 60], outputRange: [0, 1], extrapolate: 'clamp' });

  const header = (
    <View>
      <Text style={[styles.largeTitle, { color: colors.textPrimary }]} accessibilityRole="header">
        Library
      </Text>
      <SearchField value={query} onChangeText={setQuery} placeholder="Search documents" style={styles.search} />

      <View style={styles.quickGrid}>
        {quickActions.map((action) => (
          <ScalePressable
            key={action.key}
            onPress={action.onPress}
            disabled={action.busy}
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            accessibilityState={{ busy: !!action.busy }}
            style={[styles.quickCard, { backgroundColor: colors.cell, width: (width - horizontalPadding * 2 - (spacing.sm + 2)) / 2 }]}>
            <View style={[styles.quickIcon, { backgroundColor: action.tint }]}>
              <Icon name={action.icon} size={19} color="#FFFFFF" weight={2} />
            </View>
            <View style={styles.quickText}>
              <Text
                style={[styles.quickLabel, { color: colors.textPrimary }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}>
                {action.label}
              </Text>
              <Text
                style={[styles.quickCaption, { color: colors.textSecondary }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}>
                {action.busy ? 'Opening…' : action.caption}
              </Text>
            </View>
          </ScalePressable>
        ))}
      </View>

      <View style={styles.sectionRow}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
          {query ? 'Results' : settings.librarySort === 'name' ? 'All Documents' : 'Recents'}
        </Text>
        <BarButton icon={grid ? 'grid' : 'list'} onPress={showViewOptions} accessibilityLabel="View options" iconSize={22} />
      </View>
      {documents.length > 0 && (
        <SegmentedControl
          segments={[
            { value: 'all', label: 'All' },
            { value: 'pdf', label: 'PDFs' },
            { value: 'image', label: 'Images' },
          ]}
          value={filter}
          onChange={setFilter}
          style={styles.segments}
        />
      )}
    </View>
  );

  const empty = loaded ? (
    documents.length === 0 ? (
      <EmptyState
        icon="folder"
        title="No Documents Yet"
        message="Open a PDF or an image to start editing. Your documents stay on this device."
        action={<PillButton label="Open a Document" icon="plus" onPress={handleNew} style={{ marginTop: spacing.md }} />}
      />
    ) : (
      <EmptyState icon="search" title="No Results" message={query ? `Nothing matches “${query}”.` : 'No documents of this type.'} />
    )
  ) : null;

  return (
    <View style={[styles.container, { backgroundColor: colors.groupedBackground }]}>
      {/* Compact bar (title appears once the large title scrolls away) */}
      <View style={[styles.topBar, { paddingTop: insets.top, backgroundColor: colors.groupedBackground }]}>
        <View style={styles.topRow}>
          <BarButton icon="gear" onPress={() => navigation.navigate('Settings')} accessibilityLabel="Settings" />
          <Animated.Text style={[styles.compactTitle, { color: colors.textPrimary, opacity: titleOpacity }]}>
            Library
          </Animated.Text>
          <BarButton icon="plusCircle" onPress={handleNew} accessibilityLabel="Create or open a document" iconSize={28} />
        </View>
      </View>

      <Animated.FlatList
        key={grid ? `grid-${columns}` : 'list'}
        data={visible}
        keyExtractor={(item: DocumentSummary) => item.id}
        numColumns={grid ? columns : 1}
        columnWrapperStyle={grid && columns > 1 ? { gap, paddingHorizontal: horizontalPadding } : undefined}
        ListHeaderComponent={<View style={{ paddingHorizontal: horizontalPadding }}>{header}</View>}
        ListEmptyComponent={empty ?? undefined}
        ItemSeparatorComponent={() =>
          grid ? (
            <View style={{ height: spacing.xl }} />
          ) : (
            // Divider inside the list surface, aligned with the row text
            <View style={[styles.listSeparatorWrap, { backgroundColor: colors.cell }]}>
              <View style={[styles.listSeparator, { backgroundColor: colors.separator }]} />
            </View>
          )
        }
        renderItem={({ item, index }: { item: DocumentSummary; index: number }) =>
          grid ? (
            <DocumentGridCard item={item} width={cardWidth} busy={busyId === item.id} onOpen={openDocument} onMore={showItemActions} />
          ) : (
            // One continuous surface: rows share the background; only the outer corners are rounded
            <View
              style={[
                styles.listCell,
                { backgroundColor: colors.cell },
                index === 0 && styles.listCellFirst,
                index === visible.length - 1 && styles.listCellLast,
              ]}>
              <DocumentListRow item={item} busy={busyId === item.id} onOpen={openDocument} onMore={showItemActions} />
            </View>
          )
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} colors={[colors.primary]} />}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'on-drag' : 'none'}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS === 'android'}
      />

      <BottomSheet visible={!!infoItem} onClose={() => setInfoItem(null)} title="Info" right={<BarButton label="Done" prominent onPress={() => setInfoItem(null)} />}>
        {infoItem && (
          <View style={{ paddingTop: spacing.md }}>
            <ListSection>
              <ListRow title="Name" value={displayTitle(infoItem.metadata.title)} />
              <ListRow title="Kind" value={infoItem.metadata.kind === 'pdf' ? 'PDF Document' : 'Image'} />
              {infoItem.metadata.kind === 'pdf' && <ListRow title="Pages" value={String(infoItem.metadata.pageCount || '—')} />}
              <ListRow title="Added" value={formatRelativeDate(infoItem.metadata.createdAt)} />
              <ListRow title="Modified" value={formatRelativeDate(infoItem.metadata.updatedAt)} />
              <ListRow title="Location" value="On This Device" />
            </ListSection>
            <ListSection>
              <ListRow title="Open" icon="chevronRight" onPress={() => { const it = infoItem; setInfoItem(null); openDocument(it); }} />
              <ListRow title="Share" icon="share" onPress={() => { const it = infoItem; setInfoItem(null); shareItem(it); }} />
            </ListSection>
          </View>
        )}
      </BottomSheet>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { zIndex: 2 },
  topRow: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xs },
  compactTitle: { ...typography.headline },
  largeTitle: { ...typography.largeTitle, marginTop: 2 },
  search: { marginTop: spacing.sm, marginBottom: spacing.lg },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm + 2, marginBottom: spacing.xl },
  quickCard: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.lg - 2, paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md, gap: spacing.sm + 2, minHeight: 56 },
  quickIcon: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  quickText: { flex: 1, minWidth: 0 },
  quickLabel: { ...typography.subhead, fontWeight: fontWeights.semibold },
  quickCaption: { ...typography.caption, marginTop: 1 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  sectionTitle: { ...typography.titleMedium, fontWeight: fontWeights.bold },
  segments: { marginBottom: spacing.lg },
  listCell: { marginHorizontal: spacing.lg, overflow: 'hidden' },
  listCellFirst: { borderTopLeftRadius: radius.lg - 2, borderTopRightRadius: radius.lg - 2 },
  listCellLast: { borderBottomLeftRadius: radius.lg - 2, borderBottomRightRadius: radius.lg - 2 },
  listSeparatorWrap: { marginHorizontal: spacing.lg },
  listSeparator: { height: StyleSheet.hairlineWidth, marginLeft: LIST_ROW_TEXT_INSET },
});
