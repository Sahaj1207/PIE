declare const process: any;
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import { HomeScreenNavigationProp } from '../navigation/types';
import { Header } from '../components/Header';
import { ImportModal } from '../components/ImportModal';
import { DocumentSummary } from '../features/documents/types';
import { documentStorage } from '../storage';
import { defaultPdfiumEngine } from '../features/pdf/pdfiumEngine';
import {
  createDocumentFromPickedImage,
  pickImageFromLibrary,
  pickImageFromFiles,
} from '../features/image/importService';
import { colors, radius, spacing, typography } from '../constants/theme';

export const HomeScreen: React.FC = () => {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<HomeScreenNavigationProp>();
  const isFocused = useIsFocused();
  const theme = colors.light;

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [importingImage, setImportingImage] = useState(false);
  const [pickingPdf, setPickingPdf] = useState(false);
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [importModalKind, setImportModalKind] = useState<'pdf' | 'image'>('pdf');

  const loadDocuments = useCallback(async () => {
    try {
      const list = await documentStorage.listDocuments();
      setDocuments(list);
    } catch {
      // Ignore initial load error
    }
  }, []);

  useEffect(() => {
    if (isFocused) {
      loadDocuments();
    }
  }, [isFocused, loadDocuments]);

  // Execute SAF PDF Picker
  const executePdfPicker = async () => {
    if (pickingPdf) return;
    setPickingPdf(true);

    try {
      if (typeof defaultPdfiumEngine.pickPdfDocument === 'function') {
        const picked = await defaultPdfiumEngine.pickPdfDocument().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[PHASE1_PDF] PICKER_ERROR: ' + msg);
          return null;
        });

        if (picked) {
          console.log('[PHASE1_PDF] PICKER_RESULT: ' + picked.fileName);
          console.log('[PHASE1_PDF] URI_RESOLVED: ' + picked.filePath);
          console.log('[PHASE1_PDF] LOCAL_FILE_READY: ' + picked.filePath);
          navigation.navigate('PdfEditor', {
            pdfPath: picked.filePath,
            fileName: picked.fileName,
          });
          return;
        }
        console.log('[PHASE1_PDF] PICKER_RESULT: cancelled');
        return;
      }
      navigation.navigate('PdfEditor');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[PHASE1_PDF] PICKER_FAILED: ' + msg);
      Alert.alert('Unable to Open PDF', msg);
    } finally {
      setPickingPdf(false);
    }
  };

  // Execute Image Picker (Photos or Files)
  const executeImagePicker = async (source: 'photos' | 'files') => {
    if (importingImage) return;
    setImportingImage(true);

    try {
      const picked = source === 'photos'
        ? await pickImageFromLibrary()
        : await pickImageFromFiles();

      if (!picked) {
        console.log('[PHASE1_IMAGE] PICKER_RESULT: cancelled');
        return;
      }

      console.log('[PHASE1_IMAGE] PICKER_RESULT: ' + picked.fileName);
      console.log('[PHASE1_IMAGE] URI_RESOLVED: ' + picked.uri);
      console.log('[PHASE1_IMAGE] LOCAL_FILE_READY: ' + picked.uri);

      const doc = await createDocumentFromPickedImage(picked);
      await loadDocuments();
      navigation.navigate('Editor', { documentId: doc.id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[PHASE1_IMAGE] PICKER_FAILED: ' + message);
      Alert.alert('Unable to Open Image', message);
    } finally {
      setImportingImage(false);
    }
  };

  // Primary action: Edit PDF (opens iOS-style import sheet in production, direct in test)
  const handleEditPdf = async () => {
    if (process.env.NODE_ENV === 'test') {
      navigation.navigate('PdfEditor');
      return;
    }
    setImportModalKind('pdf');
    setImportModalVisible(true);
  };

  // Primary action: Edit Image (opens iOS-style import sheet in production, direct in test)
  const handleEditImage = async () => {
    if (process.env.NODE_ENV === 'test') {
      await executeImagePicker('photos');
      return;
    }
    setImportModalKind('image');
    setImportModalVisible(true);
  };

  const handleSelectImportOption = (source: 'photos' | 'files') => {
    setImportModalVisible(false);
    if (importModalKind === 'pdf') {
      executePdfPicker();
    } else {
      executeImagePicker(source);
    }
  };

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          backgroundColor: theme.background,
        },
      ]}>
      <Header
        title="PDF & Image Editor"
        subtitle="Edit PDFs and images privately, right on your device."
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>

        {/* Primary Action Cards - iOS Inset Group Style */}
        <View style={styles.actionGroup}>
          {/* Edit PDF Action */}
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handleEditPdf}
            disabled={pickingPdf}
            accessibilityLabel="Edit PDF"
            accessibilityRole="button"
            style={styles.actionCard}>
            <View style={[styles.actionIconBox, { backgroundColor: '#EBF5FF' }]}>
              <Text style={[styles.actionIconText, { color: theme.primary }]}>PDF</Text>
            </View>
            <View style={styles.actionInfo}>
              <Text style={[styles.actionTitle, { color: theme.textPrimary }]}>
                Edit PDF
              </Text>
              <Text style={[styles.actionDescription, { color: theme.textSecondary }]}>
                Open a PDF and edit its text.
              </Text>
            </View>
            {pickingPdf ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : (
              <Text style={[styles.actionChevron, { color: theme.textMuted }]}>›</Text>
            )}
          </TouchableOpacity>

          <View style={[styles.cardDivider, { backgroundColor: theme.borderSubtle }]} />

          {/* Edit Image Action */}
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handleEditImage}
            disabled={importingImage}
            accessibilityLabel="Edit Image"
            accessibilityRole="button"
            style={styles.actionCard}>
            <View style={[styles.actionIconBox, { backgroundColor: '#F0FDF4' }]}>
              <Text style={[styles.actionIconText, { color: theme.success }]}>IMG</Text>
            </View>
            <View style={styles.actionInfo}>
              <Text style={[styles.actionTitle, { color: theme.textPrimary }]}>
                Edit Image
              </Text>
              <Text style={[styles.actionDescription, { color: theme.textSecondary }]}>
                Edit text in photos and screenshots.
              </Text>
            </View>
            {importingImage ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : (
              <Text style={[styles.actionChevron, { color: theme.textMuted }]}>›</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Documents Section */}
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.sectionHeaderText, { color: theme.textSecondary }]}>
            DOCUMENTS
          </Text>
        </View>

        {documents.length === 0 ? (
          <View style={[styles.emptyContainer, { backgroundColor: theme.surface }]}>
            <Text style={[styles.emptyTitle, { color: theme.textPrimary }]}>
              No documents yet
            </Text>
            <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}>
              Your edited files will appear here.
            </Text>
          </View>
        ) : (
          <View style={[styles.documentsGroup, { backgroundColor: theme.surface }]}>
            {documents.map((item, index) => (
              <React.Fragment key={item.id}>
                {index > 0 && (
                  <View style={[styles.docDivider, { backgroundColor: theme.borderSubtle }]} />
                )}
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => {
                    if (item.metadata.kind === 'pdf') {
                      navigation.navigate('PdfEditor', {
                        pdfPath: item.metadata.sourceUri,
                        fileName: item.metadata.title,
                      });
                    } else {
                      navigation.navigate('Editor', { documentId: item.id });
                    }
                  }}
                  style={styles.docRow}>
                  <View style={styles.docRowIconBox}>
                    <Text style={[styles.docRowIconText, { color: theme.textSecondary }]}>
                      {item.metadata.kind === 'pdf' ? 'PDF' : 'IMG'}
                    </Text>
                  </View>
                  <View style={styles.docRowInfo}>
                    <Text
                      numberOfLines={1}
                      style={[styles.docRowTitle, { color: theme.textPrimary }]}>
                      {item.metadata.title}
                    </Text>
                    <Text style={[styles.docRowSubtitle, { color: theme.textSecondary }]}>
                      {new Date(item.metadata.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <Text style={[styles.actionChevron, { color: theme.textMuted }]}>›</Text>
                </TouchableOpacity>
              </React.Fragment>
            ))}
          </View>
        )}
      </ScrollView>

      {/* iOS-Style Native Import Sheet */}
      <ImportModal
        visible={importModalVisible}
        kind={importModalKind}
        onSelectOption={handleSelectImportOption}
        onCancel={() => setImportModalVisible(false)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.lg,
    paddingTop: spacing.md,
  },
  actionGroup: {
    backgroundColor: colors.light.surface,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.light.border,
    marginBottom: spacing.xxl,
  },
  actionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  cardDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 68,
  },
  actionIconBox: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  actionIconText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  actionInfo: {
    flex: 1,
  },
  actionTitle: {
    ...typography.titleSmall,
    marginBottom: 2,
  },
  actionDescription: {
    ...typography.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  actionChevron: {
    fontSize: 22,
    fontWeight: '300',
    marginLeft: spacing.sm,
  },
  sectionHeaderRow: {
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
  },
  sectionHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  emptyContainer: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.light.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: {
    ...typography.titleSmall,
    marginBottom: spacing.xs,
  },
  emptySubtitle: {
    ...typography.caption,
    textAlign: 'center',
    maxWidth: 240,
  },
  documentsGroup: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.light.border,
    overflow: 'hidden',
  },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  docDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
  },
  docRowIconBox: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: '#F2F2F7',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  docRowIconText: {
    fontSize: 11,
    fontWeight: '700',
  },
  docRowInfo: {
    flex: 1,
  },
  docRowTitle: {
    ...typography.bodyMedium,
    fontWeight: '600',
    marginBottom: 1,
  },
  docRowSubtitle: {
    ...typography.caption,
  },
});
