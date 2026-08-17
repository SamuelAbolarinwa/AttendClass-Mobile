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

export default function ResetPasswordScreen() {
  const { forceSetPassword, signOut } = useAuth();
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleReset = async () => {
    setError('');
    if (!currentPass || !newPass || !confirmPass) {
      setError('Please fill out all fields.');
      return;
    }
    if (newPass !== confirmPass) {
      setError('New passwords do not match.');
      return;
    }
    if (newPass.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    const res = await forceSetPassword(currentPass, newPass);
    if (res.error) setError(res.error);
    setLoading(false);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={T.colors.warning} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.headerBand}>
          <Text style={styles.headerIcon}>🔐</Text>
          <Text style={styles.headerTitle}>Password Reset Required</Text>
          <Text style={styles.headerSub}>
            You must set a new password before you can use the app.
          </Text>
        </View>

        <View style={styles.card}>
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {[
            { label: 'Current Password', value: currentPass, setter: setCurrentPass },
            { label: 'New Password', value: newPass, setter: setNewPass },
            { label: 'Confirm New Password', value: confirmPass, setter: setConfirmPass },
          ].map(({ label, value, setter }) => (
            <View key={label} style={styles.fieldGroup}>
              <Text style={styles.label}>{label}</Text>
              <TextInput
                style={styles.input}
                placeholder={`Enter ${label.toLowerCase()}`}
                placeholderTextColor={T.colors.inputPlaceholder}
                value={value}
                onChangeText={setter}
                secureTextEntry
                
              />
            </View>
          ))}

          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.disabledBtn]}
            onPress={handleReset}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>Set New Password</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.logoutBtn} onPress={signOut} disabled={loading}>
            <Text style={styles.logoutBtnText}>Log Out Instead</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: T.colors.warning },
  flex: { flex: 1 },
  headerBand: {
    backgroundColor: T.colors.warning,
    padding: T.spacing.lg,
    paddingTop: T.spacing.xl,
    paddingBottom: T.spacing.xl,
    alignItems: 'center',
  },
  headerIcon: { fontSize: 40, marginBottom: T.spacing.sm },
  headerTitle: { fontSize: T.fontSize.xl, fontWeight: '800', color: '#fff', textAlign: 'center', marginBottom: 4 },
  headerSub: { fontSize: T.fontSize.sm, color: 'rgba(255,255,255,0.8)', textAlign: 'center', lineHeight: 20 },
  card: {
    flex: 1,
    backgroundColor: T.colors.surface,
    borderTopLeftRadius: T.radius.xl,
    borderTopRightRadius: T.radius.xl,
    padding: T.spacing.lg,
    paddingTop: T.spacing.xl,
  },
  errorBox: {
    backgroundColor: T.colors.errorBg,
    borderRadius: T.radius.md,
    padding: T.spacing.sm + 4,
    marginBottom: T.spacing.md,
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  errorText: { color: T.colors.error, fontSize: T.fontSize.sm, fontWeight: '500' },
  fieldGroup: { marginBottom: T.spacing.md },
  label: { fontSize: T.fontSize.sm, fontWeight: '600', color: T.colors.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: T.colors.inputBg,
    borderWidth: 1,
    borderColor: T.colors.inputBorder,
    borderRadius: T.radius.md,
    paddingHorizontal: T.spacing.md,
    paddingVertical: T.spacing.sm + 4,
    fontSize: T.fontSize.base,
    color: T.colors.inputText,
  },
  primaryBtn: {
    backgroundColor: T.colors.warning,
    borderRadius: T.radius.md,
    paddingVertical: T.spacing.md,
    alignItems: 'center',
    marginTop: T.spacing.sm,
    ...T.shadow.md,
    shadowColor: T.colors.warning,
  },
  disabledBtn: { opacity: 0.6 },
  primaryBtnText: { color: '#fff', fontSize: T.fontSize.base, fontWeight: '700' },
  logoutBtn: {
    alignItems: 'center',
    paddingVertical: T.spacing.md,
    marginTop: T.spacing.sm,
  },
  logoutBtnText: { color: T.colors.textSecondary, fontSize: T.fontSize.sm },
});
