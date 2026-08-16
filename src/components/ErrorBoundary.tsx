import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Clipboard,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { logCrash } from '../utils/errorLogger';
import { T } from '../theme/tokens';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
  stack: string;
  componentStack: string;
}

/**
 * ErrorBoundary wraps the entire app tree.
 * On any React render crash it displays the full error on-screen with a
 * "Copy to Clipboard" button so it can be shared without adb/logcat.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      message: '',
      stack: '',
      componentStack: '',
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      message: error?.message ?? String(error),
      stack: error?.stack ?? '(no stack trace)',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const componentStack = info?.componentStack ?? '(no component stack)';
    this.setState({ componentStack });
    logCrash({
      ts: new Date().toISOString(),
      type: 'react',
      message: error?.message ?? String(error),
      stack: (error?.stack ?? '') + '\n\nComponent Stack:\n' + componentStack,
    });
  }

  handleCopy = () => {
    const text = [
      `=== AttendClass Crash Report ===`,
      `Time: ${new Date().toISOString()}`,
      ``,
      `Error: ${this.state.message}`,
      ``,
      `JS Stack:`,
      this.state.stack,
      ``,
      `Component Stack:`,
      this.state.componentStack,
    ].join('\n');

    Clipboard.setString(text);
    Alert.alert('Copied', 'Crash report copied to clipboard.');
  };

  handleRetry = () => {
    this.setState({
      hasError: false,
      message: '',
      stack: '',
      componentStack: '',
    });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>⚠️ App Crashed</Text>
          <Text style={styles.headerSub}>
            Share the details below with your developer.
          </Text>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <View style={styles.errorSection}>
            <Text style={styles.sectionLabel}>Error Message</Text>
            <Text style={styles.errorMessage}>{this.state.message}</Text>
          </View>

          <View style={styles.errorSection}>
            <Text style={styles.sectionLabel}>JS Stack Trace</Text>
            <Text style={styles.codeText}>{this.state.stack}</Text>
          </View>

          {this.state.componentStack ? (
            <View style={styles.errorSection}>
              <Text style={styles.sectionLabel}>Component Stack</Text>
              <Text style={styles.codeText}>{this.state.componentStack}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.copyBtn} onPress={this.handleCopy}>
            <Text style={styles.copyBtnText}>📋 Copy Report to Clipboard</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.retryBtn} onPress={this.handleRetry}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: T.colors.errorBg,
  },
  header: {
    backgroundColor: T.colors.error,
    padding: T.spacing.lg,
    paddingTop: T.spacing.xl,
  },
  headerTitle: {
    color: '#fff',
    fontSize: T.fontSize.xl,
    fontWeight: '700',
    marginBottom: 4,
  },
  headerSub: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: T.fontSize.sm,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: T.spacing.md,
    gap: T.spacing.md,
  },
  errorSection: {
    backgroundColor: '#fff',
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    borderWidth: 1,
    borderColor: T.colors.border,
  },
  sectionLabel: {
    fontSize: T.fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: T.colors.textSecondary,
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  errorMessage: {
    fontSize: T.fontSize.base,
    color: T.colors.error,
    fontWeight: '600',
  },
  codeText: {
    fontSize: 11,
    color: T.colors.text,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  actions: {
    padding: T.spacing.md,
    gap: T.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: T.colors.border,
    backgroundColor: '#fff',
  },
  copyBtn: {
    backgroundColor: T.colors.error,
    padding: T.spacing.md,
    borderRadius: T.radius.md,
    alignItems: 'center',
  },
  copyBtnText: {
    color: '#fff',
    fontSize: T.fontSize.base,
    fontWeight: '700',
  },
  retryBtn: {
    backgroundColor: T.colors.surface,
    padding: T.spacing.md,
    borderRadius: T.radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: T.colors.border,
  },
  retryBtnText: {
    color: T.colors.text,
    fontSize: T.fontSize.base,
    fontWeight: '600',
  },
});
