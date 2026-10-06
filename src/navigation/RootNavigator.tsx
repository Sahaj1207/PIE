import React from 'react';
import { Platform } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from './types';
import { HomeScreen } from '../screens/HomeScreen';
import { EditorScreen } from '../screens/EditorScreen';
import { PdfEditorScreen } from '../screens/PdfEditorScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { useTheme } from '../ui/ThemeProvider';

const Stack = createNativeStackNavigator<RootStackParamList>();

export const RootNavigator: React.FC = () => {
  const { colors } = useTheme();
  return (
    <Stack.Navigator
      initialRouteName="Home"
      screenOptions={{
        headerShown: false,
        // iOS: native push; Android: matching slide-in.
        animation: Platform.OS === 'ios' ? 'default' : 'slide_from_right',
        contentStyle: { backgroundColor: colors.groupedBackground },
      }}>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      {/* Editors handle unsaved changes themselves: no swipe-back past their prompt. */}
      <Stack.Screen name="Editor" component={EditorScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="PdfEditor" component={PdfEditorScreen} options={{ gestureEnabled: false }} />
    </Stack.Navigator>
  );
};
