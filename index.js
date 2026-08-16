/**
 * @format
 *
 * Global error handlers are installed HERE, before AppRegistry.registerComponent,
 * so they catch crashes that happen during module init and native setup — before
 * any React component or ErrorBoundary is mounted.
 */

import { AppRegistry, Alert } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { installGlobalErrorHandlers, CrashEntry } from './src/utils/errorLogger';

// Install global JS error + unhandled rejection handlers.
// The callback is called whenever a crash is logged so we can show an Alert
// for native-level crashes that happen outside the React error boundary.
installGlobalErrorHandlers((entry: CrashEntry) => {
  // Show a non-blocking alert. The error is already written to the log file
  // so the user can copy it even if they dismiss this alert.
  Alert.alert(
    '⚠️ Unexpected Error',
    `${entry.message}\n\nA crash report has been saved. Check Settings → Error Log or share the log file with your developer.`,
    [{ text: 'OK' }],
  );
});

AppRegistry.registerComponent(appName, () => App);
