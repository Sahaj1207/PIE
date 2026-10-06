import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';

export type RootStackParamList = {
  Home: undefined;
  Settings: undefined;
  Editor: {
    documentId?: string;
  };
  PdfEditor: {
    pdfPath?: string;
    fileName?: string;
    /** Existing persisted PDF record to update on save (reopened from Home). */
    documentId?: string;
  } | undefined;
};

export type HomeScreenNavigationProp = NativeStackNavigationProp<
  RootStackParamList,
  'Home'
>;

export type EditorScreenNavigationProp = NativeStackNavigationProp<
  RootStackParamList,
  'Editor'
>;

export type EditorScreenRouteProp = RouteProp<RootStackParamList, 'Editor'>;

export type PdfEditorScreenNavigationProp = NativeStackNavigationProp<
  RootStackParamList,
  'PdfEditor'
>;

export type PdfEditorScreenRouteProp = RouteProp<
  RootStackParamList,
  'PdfEditor'
>;

export type SettingsScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Settings'>;
