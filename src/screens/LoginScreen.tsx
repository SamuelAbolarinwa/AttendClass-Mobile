import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { T } from '../theme/tokens';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!identifier.trim() || !password) {
      setError('Please enter your username and password.');
      return;
    }
    setLoading(true);
    setError('');
    const res = await signIn(identifier.trim(), password);
    if (res.error) setError(res.error);
    setLoading(false);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={T.colors.primary600} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header band */}
        <View style={styles.headerBand}>
          <Text style={styles.appName}>AttendClass</Text>
          <Text style={styles.tagline}>Staff Attendance Portal</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Welcome back</Text>
          <Text style={styles.cardSub}>Sign in to view your attendance</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Username or Email</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your username"
              placeholderTextColor={T.colors.inputPlaceholder}
              value={identifier}
              onChangeText={setIdentifier}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              // ── Fix: explicit color ensures text is visible on any background ──
              color={T.colors.inputText}
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your password"
              placeholderTextColor={T.colors.inputPlaceholder}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              returnKeyType="done"
              onSubmitEditing={handleLogin}
              color={T.colors.inputText}
            />
          </View>

          <TouchableOpacity
            style={[styles.loginBtn, loading && styles.loginBtnDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.loginBtnText}>Sign In</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: T.colors.primary600,
  },
  flex: {
    flex: 1,
  },
  headerBand: {
    backgroundColor: T.colors.primary600,
    paddingHorizontal: T.spacing.lg,
    paddingTop: T.spacing.xxl,
    paddingBottom: T.spacing.xl,
    alignItems: 'center',
  },
  appName: {
    fontSize: 34,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: T.fontSize.sm,
    color: 'rgba(255,255,255,0.7)',
    marginTop: 4,
    letterSpacing: 0.3,
  },
  card: {
    flex: 1,
    backgroundColor: T.colors.surface,
    borderTopLeftRadius: T.radius.xl,
    borderTopRightRadius: T.radius.xl,
    padding: T.spacing.lg,
    paddingTop: T.spacing.xl,
  },
  cardTitle: {
    fontSize: T.fontSize.xl,
    fontWeight: '700',
    color: T.colors.text,
    marginBottom: 4,
  },
  cardSub: {
    fontSize: T.fontSize.sm,
    color: T.colors.textSecondary,
    marginBottom: T.spacing.lg,
  },
  errorBox: {
    backgroundColor: T.colors.errorBg,
    borderWidth: 1,
    borderColor: '#fecdd3',
    borderRadius: T.radius.md,
    padding: T.spacing.sm + 4,
    marginBottom: T.spacing.md,
  },
  errorText: {
    color: T.colors.error,
    fontSize: T.fontSize.sm,
    fontWeight: '500',
  },
  fieldGroup: {
    marginBottom: T.spacing.md,
  },
  label: {
    fontSize: T.fontSize.sm,
    fontWeight: '600',
    color: T.colors.textSecondary,
    marginBottom: 6,
  },
  input: {
    backgroundColor: T.colors.inputBg,
    borderWidth: 1,
    borderColor: T.colors.inputBorder,
    borderRadius: T.radius.md,
    paddingHorizontal: T.spacing.md,
    paddingVertical: T.spacing.sm + 4,
    fontSize: T.fontSize.base,
    // ── Fix: explicit dark text color prevents invisible input on Android ──
    color: T.colors.inputText,
  },
  loginBtn: {
    backgroundColor: T.colors.primary,
    borderRadius: T.radius.md,
    paddingVertical: T.spacing.md,
    alignItems: 'center',
    marginTop: T.spacing.sm,
    ...T.shadow.md,
    shadowColor: T.colors.primary,
  },
  loginBtnDisabled: {
    opacity: 0.6,
  },
  loginBtnText: {
    color: '#fff',
    fontSize: T.fontSize.base,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
