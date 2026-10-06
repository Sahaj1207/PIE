/**
 * @format
 */

import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';
import App from './src/app/App';
import { name as appName } from './app.json';

// Release builds: drop verbose diagnostic logging (warnings and errors are kept).
if (!__DEV__) {
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
}

AppRegistry.registerComponent(appName, () => App);
