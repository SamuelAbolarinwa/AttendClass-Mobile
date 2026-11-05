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
import { DiagnosticLogger } from '../services/DiagnosticLogger';
import { T } from '../theme/tokens';

export default function SettingsScreen({ navigation }: any) {
  const {
    account,
    authStatus,
    isDeviceEnrolled,
    enrollDeviceWithCode,
    revokeDeviceCredential,
    requestDeviceChange,
    signOut,
  } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Device enrolment state
  const [activationCode, setActivationCode] = useState('');
  const [enrollingDevice, setEnrollingDevice] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollSuccess, setEnrollSuccess] = useState(false);

  // Device change request state
  const [showChangeRequest, setShowChangeRequest] = useState(false);
  const [changeReason, setChangeReason] = useState('');
  const [submittingChange, setSubmittingChange] = useState(false);
  const [changeFeedback, setChangeFeedback] = useState<string | null>(null);

  // Diagnostics view
  const [showLogs, setShowLogs] = useState(false);

  const handleEnrollDevice = async () => {
    setEnrollError(null);
    setEnrollSuccess(false);

    if (!activationCode.trim()) {
      setEnrollError('Please enter the activation code provided by your administrator.');
      return;
    }

    setEnrollingDevice(true);
    const result = await enrollDeviceWithCode(activationCode);
    setEnrollingDevice(false);

    if (result.error) {
      setEnrollError(result.error);
    } else {
      setEnrollSuccess(true);
      setActivationCode('');
      Alert.alert(
        'Device Authorised',
        'Your phone has been bound to your account with a non-exportable hardware key and is authorised for attendance.',
      );
    }
  };

  const handleRevokeCredential = () => {
    Alert.alert(
      'Revoke Device Credential',
      'This will remove your authorised attendance key from this phone. You will not be able to mark attendance until you enrol again with an administrator activation code. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke Key',
          style: 'destructive',
          onPress: async () => {
            const res = await revokeDeviceCredential();
            if (res.error) {
              Alert.alert('Error', res.error);
            } else {
              Alert.alert('Credential Revoked', 'Attendance signing key was removed.');
            }
          },
        },
      ],
    );
  };

  const handleSubmitChangeRequest = async () => {
    if (!changeReason.trim()) {
      Alert.alert('Reason Required', 'Please provide a reason for replacing your registered phone.');
      return;
    }
    setSubmittingChange(true);
    setChangeFeedback(null);
    const res = await requestDeviceChange(changeReason.trim());
    setSubmittingChange(false);
    if (res.error) {
      setChangeFeedback(`⚠️ ${res.error}`);
    } else {
      setChangeFeedback('✓ Device change request submitted. Your course administrator will review it.');
      setChangeReason('');
    }
  };

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

      const res = data as Record<string, unknown> | null;
      if (!res?.ok) throw new Error((res?.error as string) || 'Failed to change password.');

      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      Alert.alert('Success', 'Your password has been changed.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
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
        <Text style={styles.headerTitle}>Settings & Device</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* Account info card */}
        <View style={styles.accountCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarInitial}>
              {account?.full_name?.[0]?.toUpperCase() ?? '?'}
            </Text>
          </View>
          <View style={styles.accountDetails}>
            <Text style={styles.accountName}>{account?.full_name}</Text>
            <Text style={styles.accountRole}>{account?.role}</Text>
            <View style={styles.statusBadge}>
              <Text style={styles.statusBadgeText}>
                {authStatus === 'ONLINE_AUTHENTICATED' && '🟢 Online'}
                {authStatus === 'OFFLINE_AUTHORISED' && '🟡 Authorised Offline'}
                {authStatus === 'CREDENTIAL_EXPIRED_OR_REVOKED' && '🔴 Re-auth Required'}
                {authStatus === 'SIGNED_OUT' && '⚪ Signed Out'}
              </Text>
            </View>
          </View>
        </View>

        {/* Device Enrolment Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Device Enrolment</Text>
          <Text style={styles.sectionSubtitle}>
            Attendance terminal checks require an authorised phone signing key.
          </Text>

          <View style={styles.enrolmentStatusRow}>
            <Text style={styles.enrolmentLabel}>Device Status:</Text>
            <Text
              style={[
                styles.enrolmentValue,
                { color: isDeviceEnrolled ? T.colors.success : T.colors.warning },
              ]}
            >
              {isDeviceEnrolled ? '✓ Authorised Device' : '⚠️ Not Enrolled'}
            </Text>
          </View>

          {enrollError ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{enrollError}</Text>
            </View>
          ) : null}

          {enrollSuccess ? (
            <View style={styles.successBox}>
              <Text style={styles.successText}>Device successfully registered and bound!</Text>
            </View>
          ) : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Admin Activation Code</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. ACT-8ABC23"
              placeholderTextColor={T.colors.inputPlaceholder}
              value={activationCode}
              onChangeText={setActivationCode}
              autoCapitalize="characters"
            />
            <Text style={styles.helperText}>
              Codes are single-use and short-lived. Contact your lecturer or system admin to obtain one.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.primaryBtn, enrollingDevice && styles.disabledBtn]}
            onPress={handleEnrollDevice}
            disabled={enrollingDevice}
          >
            {enrollingDevice ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryBtnText}>
                {isDeviceEnrolled ? 'Replace Device Credential' : 'Enrol This Phone'}
              </Text>
            )}
          </TouchableOpacity>

          {isDeviceEnrolled && (
            <TouchableOpacity
              style={styles.revokeLink}
              onPress={handleRevokeCredential}
            >
              <Text style={styles.revokeLinkText}>Revoke Attendance Credential</Text>
            </TouchableOpacity>
          )}

          {/* Device Change Request Workflow */}
          <View style={styles.changeRequestDivider} />
          <TouchableOpacity
            style={styles.changeRequestToggle}
            onPress={() => setShowChangeRequest((prev) => !prev)}
          >
            <Text style={styles.changeRequestToggleText}>
              {showChangeRequest ? '▲ Hide Device Change Request' : '▼ Request Device Change (Lost/New Phone)'}
            </Text>
          </TouchableOpacity>

          {showChangeRequest && (
            <View style={styles.changeRequestBox}>
              <Text style={styles.changeRequestInfo}>
                Under the one-phone-per-student security policy, registering a replacement phone requires approval from your course representative or lecturer.
              </Text>
              {changeFeedback ? (
                <Text style={styles.changeFeedbackText}>{changeFeedback}</Text>
              ) : null}
              <TextInput
                style={styles.changeInput}
                placeholder="Explain why you need to replace your phone (e.g. upgraded device, lost previous phone)..."
                placeholderTextColor={T.colors.inputPlaceholder}
                value={changeReason}
                onChangeText={setChangeReason}
                multiline
                numberOfLines={3}
              />
              <TouchableOpacity
                style={[styles.outlineBtn, submittingChange && styles.disabledBtn]}
                onPress={handleSubmitChangeRequest}
                disabled={submittingChange}
              >
                {submittingChange ? (
                  <ActivityIndicator color={T.colors.primary} size="small" />
                ) : (
                  <Text style={styles.outlineBtnText}>Submit Replacement Request</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
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
              />
            </View>
          ))}

          <TouchableOpacity
            style={[styles.outlineBtn, loading && styles.disabledBtn]}
            onPress={handleChangePassword}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={T.colors.primary} size="small" />
            ) : (
              <Text style={styles.outlineBtnText}>Update Password</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Diagnostic Logs */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.logsToggleRow}
            onPress={() => setShowLogs(!showLogs)}
          >
            <Text style={styles.sectionTitle}>Diagnostic Logs</Text>
            <Text style={styles.logsToggleText}>{showLogs ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>

          {showLogs && (
            <View style={styles.logsContainer}>
              {DiagnosticLogger.getRecentLogs().length === 0 ? (
                <Text style={styles.emptyLogsText}>No diagnostic logs recorded yet.</Text>
              ) : (
                DiagnosticLogger.getRecentLogs()
                  .slice(-10)
                  .map((log) => (
                    <View key={log.id} style={styles.logItem}>
                      <Text style={styles.logMeta}>
                        [{log.timestamp.substring(11, 19)}] {log.stage}
                        {log.durationMs ? ` (${log.durationMs}ms)` : ''}
                      </Text>
                      <Text style={styles.logMsg}>{log.message}</Text>
                    </View>
                  ))
              )}
            </View>
          )}
        </View>

        {/* Log Out */}
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogOut}>
          <Text style={styles.logoutBtnText}>Log Out</Text>
        </TouchableOpacity>
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
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.md,
    backgroundColor: T.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: T.colors.border,
  },
  backBtn: {
    marginRight: T.spacing.md,
    padding: T.spacing.xs,
  },
  backArrow: {
    fontSize: T.fontSize.xl,
    color: T.colors.text,
  },
  headerTitle: {
    fontSize: T.fontSize.lg,
    fontWeight: '700',
    color: T.colors.text,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: T.spacing.lg,
    gap: T.spacing.lg,
  },
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: T.colors.surface,
    padding: T.spacing.lg,
    borderRadius: T.radius.lg,
    ...T.shadow.sm,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: T.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: T.spacing.md,
  },
  avatarInitial: {
    color: '#fff',
    fontSize: T.fontSize.xl,
    fontWeight: '700',
  },
  accountDetails: {
    flex: 1,
  },
  accountName: {
    fontSize: T.fontSize.base,
    fontWeight: '700',
    color: T.colors.text,
  },
  accountRole: {
    fontSize: T.fontSize.xs,
    color: T.colors.textSecondary,
    textTransform: 'capitalize',
    marginTop: 2,
  },
  statusBadge: {
    marginTop: 4,
  },
  statusBadgeText: {
    fontSize: T.fontSize.xs,
    color: T.colors.textSecondary,
  },
  section: {
    backgroundColor: T.colors.surface,
    padding: T.spacing.lg,
    borderRadius: T.radius.lg,
    ...T.shadow.sm,
  },
  sectionTitle: {
    fontSize: T.fontSize.base,
    fontWeight: '700',
    color: T.colors.text,
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: T.fontSize.xs,
    color: T.colors.textSecondary,
    marginBottom: T.spacing.md,
  },
  enrolmentStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: T.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: T.colors.border,
    marginBottom: T.spacing.md,
  },
  enrolmentLabel: {
    fontSize: T.fontSize.sm,
    color: T.colors.textSecondary,
    fontWeight: '500',
  },
  enrolmentValue: {
    fontSize: T.fontSize.sm,
    fontWeight: '700',
  },
  fieldGroup: {
    marginBottom: T.spacing.md,
  },
  label: {
    fontSize: T.fontSize.sm,
    fontWeight: '600',
    color: T.colors.text,
    marginBottom: 6,
  },
  input: {
    backgroundColor: T.colors.inputBg,
    borderWidth: 1,
    borderColor: T.colors.inputBorder,
    borderRadius: T.radius.md,
    paddingHorizontal: T.spacing.md,
    paddingVertical: 10,
    fontSize: T.fontSize.sm,
    color: T.colors.text,
  },
  helperText: {
    fontSize: T.fontSize.xs,
    color: T.colors.textMuted,
    marginTop: 4,
  },
  errorBox: {
    backgroundColor: T.colors.errorBg,
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
  },
  errorText: {
    color: T.colors.error,
    fontSize: T.fontSize.xs,
  },
  successBox: {
    backgroundColor: '#ecfdf5',
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
  },
  successText: {
    color: '#059669',
    fontSize: T.fontSize.xs,
  },
  primaryBtn: {
    backgroundColor: T.colors.primary,
    paddingVertical: 12,
    borderRadius: T.radius.md,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: T.fontSize.sm,
    fontWeight: '700',
  },
  outlineBtn: {
    borderWidth: 1,
    borderColor: T.colors.primary,
    paddingVertical: 12,
    borderRadius: T.radius.md,
    alignItems: 'center',
    marginTop: 4,
  },
  outlineBtnText: {
    color: T.colors.primary,
    fontSize: T.fontSize.sm,
    fontWeight: '700',
  },
  disabledBtn: {
    opacity: 0.6,
  },
  logsToggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  logsToggleText: {
    fontSize: T.fontSize.xs,
    color: T.colors.primary,
    fontWeight: '600',
  },
  logsContainer: {
    marginTop: T.spacing.md,
    backgroundColor: T.colors.bg,
    padding: T.spacing.sm,
    borderRadius: T.radius.md,
  },
  emptyLogsText: {
    fontSize: T.fontSize.xs,
    color: T.colors.textMuted,
    textAlign: 'center',
    paddingVertical: T.spacing.sm,
  },
  logItem: {
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: T.colors.border,
  },
  logMeta: {
    fontSize: 10,
    color: T.colors.textMuted,
    fontWeight: '600',
  },
  logMsg: {
    fontSize: 11,
    color: T.colors.text,
  },
  revokeLink: {
    alignSelf: 'center',
    paddingVertical: T.spacing.sm,
    marginTop: T.spacing.xs,
  },
  revokeLinkText: {
    color: '#dc2626',
    fontSize: T.fontSize.xs,
    fontWeight: '600',
  },
  changeRequestDivider: {
    height: 1,
    backgroundColor: T.colors.border,
    marginVertical: T.spacing.md,
  },
  changeRequestToggle: {
    paddingVertical: T.spacing.xs,
    alignItems: 'center',
  },
  changeRequestToggleText: {
    color: T.colors.primary,
    fontSize: T.fontSize.xs,
    fontWeight: '700',
  },
  changeRequestBox: {
    marginTop: T.spacing.sm,
    padding: T.spacing.md,
    backgroundColor: T.colors.bg,
    borderRadius: T.radius.md,
  },
  changeRequestInfo: {
    fontSize: T.fontSize.xs,
    color: T.colors.textSecondary,
    marginBottom: T.spacing.sm,
    lineHeight: 16,
  },
  changeFeedbackText: {
    fontSize: T.fontSize.xs,
    fontWeight: '700',
    color: T.colors.primary,
    marginBottom: T.spacing.xs,
  },
  changeInput: {
    backgroundColor: T.colors.surface,
    borderWidth: 1,
    borderColor: T.colors.border,
    borderRadius: T.radius.md,
    padding: T.spacing.sm,
    fontSize: T.fontSize.xs,
    color: T.colors.text,
    textAlignVertical: 'top',
    marginBottom: T.spacing.sm,
    minHeight: 60,
  },
  logoutBtn: {
    backgroundColor: '#fee2e2',
    paddingVertical: 14,
    borderRadius: T.radius.lg,
    alignItems: 'center',
    marginTop: T.spacing.sm,
    marginBottom: T.spacing.xxl,
  },
  logoutBtnText: {
    color: '#dc2626',
    fontSize: T.fontSize.base,
    fontWeight: '700',
  },
});
