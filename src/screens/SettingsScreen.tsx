import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { T } from '../theme/tokens';

export default function SettingsScreen({ navigation }: any) {
  const { account, signOut } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleChangePassword = async () => {
    setError(null);
    setSuccess(false);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('Please fill out all fields.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('platform_change_password', {
        p_token: account?.token,
        p_current_password: currentPassword,
        p_new_password: newPassword,
      });

      if (rpcErr) throw rpcErr;

      const res = data as any;
      if (!res.ok) throw new Error(res.error || 'Failed to change password.');

      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      Alert.alert('Success', 'Your password has been changed.');
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogOut = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: signOut },
    ]);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={T.colors.surface} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>

        {/* Account info pill */}
        <View style={styles.accountCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarInitial}>
              {account?.full_name?.[0]?.toUpperCase() ?? '?'}
            </Text>
          </View>
          <View>
            <Text style={styles.accountName}>{account?.full_name}</Text>
            <Text style={styles.accountRole}>{account?.role}</Text>
          </View>
        </View>

        {/* Change Password */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Change Password</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
          {success ? (
            <View style={styles.successBox}>
              <Text style={styles.successText}>Password changed successfully!</Text>
            </View>
          ) : null}

          {[
            { label: 'Current Password', value: currentPassword, setter: setCurrentPassword },
            { label: 'New Password', value: newPassword, setter: setNewPassword },
            { label: 'Confirm New Password', value: confirmPassword, setter: setConfirmPassword },
          ].map(({ label, value, setter }) => (
            <View key={label} style={styles.fieldGroup}>
              <Text style={styles.label}>{label}</Text>
              <TextInput
                style={styles.input}
                secureTextEntry
                placeholder={`Enter ${label.toLowerCase()}`}
                placeholderTextColor={T.colors.inputPlaceholder}
                value={value}
                onChangeText={setter}
                // ── Fix: explicit text color prevents invisible text ──
                color={T.colors.inputText}
              />
            </View>
          ))}

          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.disabledBtn]}
            onPress={handleChangePassword}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>Update Password</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Face Recognition */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Face Recognition</Text>
          <Text style={styles.helperText}>
            If you're having trouble checking in, you can re-enroll your face data.
          </Text>
          <TouchableOpacity
            style={styles.outlineBtn}
            onPress={() => navigation.navigate('EnrollFace')}
            activeOpacity={0.8}
          >
            <Text style={styles.outlineBtnText}>Re-enroll Face</Text>
          </TouchableOpacity>
        </View>

        {/* Log Out */}
        <TouchableOpacity style={styles.dangerBtn} onPress={handleLogOut} activeOpacity={0.8}>
          <Text style={styles.dangerBtnText}>Log Out</Text>
        </TouchableOpacity>

        <View style={{ height: T.spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: T.colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: T.colors.surface,
    paddingHorizontal: T.spacing.md,
    paddingVertical: T.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: T.colors.border,
  },
  backBtn: {
    padding: T.spacing.sm,
    marginRight: T.spacing.sm,
  },
  backArrow: {
    fontSize: T.fontSize.xl,
    color: T.colors.primary,
    fontWeight: '700',
  },
  headerTitle: {
    fontSize: T.fontSize.xl,
    fontWeight: '700',
    color: T.colors.text,
  },
  scroll: { flex: 1 },
  scrollContent: {
    padding: T.spacing.md,
    gap: T.spacing.md,
  },
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.lg,
    padding: T.spacing.md,
    gap: T.spacing.md,
    ...T.shadow.sm,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: T.radius.full,
    backgroundColor: T.colors.primary100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: T.fontSize.xl,
    fontWeight: '700',
    color: T.colors.primary600,
  },
  accountName: {
    fontSize: T.fontSize.base,
    fontWeight: '700',
    color: T.colors.text,
  },
  accountRole: {
    fontSize: T.fontSize.sm,
    color: T.colors.textSecondary,
    textTransform: 'capitalize',
    marginTop: 2,
  },
  section: {
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.lg,
    padding: T.spacing.md,
    ...T.shadow.sm,
  },
  sectionTitle: {
    fontSize: T.fontSize.lg,
    fontWeight: '700',
    color: T.colors.text,
    marginBottom: T.spacing.md,
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
    // ── Fix: explicit text color ──
    color: T.colors.inputText,
  },
  helperText: {
    fontSize: T.fontSize.sm,
    color: T.colors.textSecondary,
    marginBottom: T.spacing.md,
    lineHeight: 20,
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
  successBox: {
    backgroundColor: T.colors.successBg,
    borderRadius: T.radius.md,
    padding: T.spacing.sm + 4,
    marginBottom: T.spacing.md,
    borderWidth: 1,
    borderColor: '#6ee7b7',
  },
  successText: { color: T.colors.success, fontSize: T.fontSize.sm, fontWeight: '500' },
  primaryBtn: {
    backgroundColor: T.colors.primary,
    borderRadius: T.radius.md,
    paddingVertical: T.spacing.md,
    alignItems: 'center',
    ...T.shadow.md,
    shadowColor: T.colors.primary,
  },
  disabledBtn: { opacity: 0.6 },
  primaryBtnText: { color: '#fff', fontSize: T.fontSize.base, fontWeight: '700' },
  outlineBtn: {
    borderWidth: 1.5,
    borderColor: T.colors.primary,
    borderRadius: T.radius.md,
    paddingVertical: T.spacing.md,
    alignItems: 'center',
  },
  outlineBtnText: { color: T.colors.primary, fontSize: T.fontSize.base, fontWeight: '700' },
  dangerBtn: {
    backgroundColor: T.colors.errorBg,
    borderWidth: 1,
    borderColor: '#fecdd3',
    borderRadius: T.radius.lg,
    paddingVertical: T.spacing.md,
    alignItems: 'center',
    ...T.shadow.sm,
  },
  dangerBtnText: { color: T.colors.error, fontSize: T.fontSize.base, fontWeight: '700' },
});
