import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  ScrollView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { AttendanceManager, AttendanceFlowState } from '../services/AttendanceManager';
import { AttendanceReceipt } from '../services/AttendanceReceiptStorage';
import { T } from '../theme/tokens';

export default function CheckInScreen({ navigation }: any) {
  const { account, isDeviceEnrolled } = useAuth();
  const [flowState, setFlowState] = useState<AttendanceFlowState>('IDLE');
  const [statusMessage, setStatusMessage] = useState('Ready to check in');
  const [receipt, setReceipt] = useState<AttendanceReceipt | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const attendanceManagerRef = useRef<AttendanceManager | null>(null);

  useEffect(() => {
    attendanceManagerRef.current = new AttendanceManager();
    return () => {
      attendanceManagerRef.current?.destroy();
    };
  }, []);

  const handleStartAttendance = useCallback(async () => {
    if (!account) return;
    setIsProcessing(true);
    setErrorMessage(null);
    setReceipt(null);

    const manager = attendanceManagerRef.current || new AttendanceManager();

    const result = await manager.executeAttendance({
      accountId: account.id,
      studentId: account.id,
      matricNumber: account.matric_number || account.identifier,
      rssiThreshold: -85,
      onStateChange: (state, message) => {
        setFlowState(state);
        setStatusMessage(message);
      },
    });

    setIsProcessing(false);
    setFlowState(result.state);

    if (result.success && result.receipt) {
      setReceipt(result.receipt);
    } else if (!result.success) {
      setErrorMessage(result.errorMessage || 'Check-in failed');
    }
  }, [account]);

  const renderContent = () => {
    if (!isDeviceEnrolled) {
      return (
        <View style={styles.card}>
          <Text style={styles.icon}>📱</Text>
          <Text style={styles.title}>Device Enrolment Required</Text>
          <Text style={styles.description}>
            This phone has not been enrolled as an authorised device yet. Please request a one-time activation code from your course administrator to link this phone.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.navigate('Settings')}
          >
            <Text style={styles.primaryBtnText}>Go to Device Enrolment</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (flowState === 'SUCCESS' && receipt) {
      return (
        <View style={styles.card}>
          <Text style={styles.icon}>✅</Text>
          <Text style={styles.title}>Attendance Confirmed</Text>
          <Text style={styles.description}>
            Your attendance has been cryptographically signed and durably persisted on the terminal SD card.
          </Text>

          <View style={styles.receiptBox}>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Student:</Text>
              <Text style={styles.receiptValue}>{account?.full_name}</Text>
            </View>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Matric No:</Text>
              <Text style={styles.receiptValue}>{receipt.matricNumber}</Text>
            </View>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Terminal:</Text>
              <Text style={styles.receiptValue}>{receipt.terminalId}</Text>
            </View>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Date (Lagos):</Text>
              <Text style={styles.receiptValue}>{receipt.lagosDate}</Text>
            </View>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>SD Persistence:</Text>
              <Text style={[styles.receiptValue, { color: T.colors.success }]}>
                Verified (Record #{receipt.sdRecordIndex ?? 1})
              </Text>
            </View>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Event ID:</Text>
              <Text style={[styles.receiptValue, styles.monoText]}>
                {receipt.eventId.substring(0, 16)}…
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (flowState === 'ALREADY_LOGGED') {
      return (
        <View style={styles.card}>
          <Text style={styles.icon}>📋</Text>
          <Text style={styles.title}>Already Checked In</Text>
          <Text style={styles.description}>
            Attendance for today ({receipt?.lagosDate || 'today'}) has already been recorded for this device.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (flowState === 'FAILED') {
      return (
        <View style={styles.card}>
          <Text style={styles.icon}>❌</Text>
          <Text style={styles.title}>Check-In Not Completed</Text>
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
          <Text style={styles.helpText}>
            Ensure you are near an authorized AttendClass terminal (ESP32) with Bluetooth turned on.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleStartAttendance}
          >
            <Text style={styles.primaryBtnText}>Try Again</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.outlineBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.outlineBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (isProcessing) {
      return (
        <View style={styles.card}>
          <ActivityIndicator size="large" color={T.colors.primary} style={styles.spinner} />
          <Text style={styles.stateTitle}>
            {flowState === 'SCANNING_TERMINAL' && 'Scanning for Terminal…'}
            {flowState === 'CONNECTING_TERMINAL' && 'Connecting to Terminal…'}
            {flowState === 'FETCHING_CHALLENGE' && 'Obtaining Challenge…'}
            {flowState === 'LOCAL_APPROVAL' && 'Awaiting Authorisation…'}
            {flowState === 'SUBMITTING_ATTENDANCE' && 'Sending Signed Check-in…'}
            {flowState === 'AWAITING_SD_ACK' && 'Awaiting SD Persistence ACK…'}
            {flowState === 'CHECKING_STATUS' && 'Checking Records…'}
          </Text>
          <Text style={styles.stateSubtitle}>{statusMessage}</Text>
          <TouchableOpacity
            style={styles.cancelLink}
            onPress={() => {
              attendanceManagerRef.current?.cancel();
              setIsProcessing(false);
              setFlowState('IDLE');
            }}
          >
            <Text style={styles.cancelLinkText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // Default: IDLE state
    return (
      <View style={styles.card}>
        <Text style={styles.icon}>📡</Text>
        <Text style={styles.title}>Terminal Check-In</Text>
        <Text style={styles.description}>
          Hold your phone near the classroom AttendClass terminal. When connected, approve the transaction with your biometric or screen lock to sign your attendance.
        </Text>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={handleStartAttendance}
        >
          <Text style={styles.primaryBtnText}>Start Check-In</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor={T.colors.bg} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Class Attendance</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {renderContent()}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: T.colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: T.colors.border,
    backgroundColor: T.colors.surface,
  },
  backBtn: {
    paddingVertical: T.spacing.xs,
    paddingHorizontal: T.spacing.sm,
  },
  backBtnText: {
    color: T.colors.primary,
    fontSize: T.fontSize.base,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: T.fontSize.lg,
    fontWeight: '700',
    color: T.colors.text,
  },
  headerSpacer: {
    width: 60,
  },
  scrollContent: {
    flexGrow: 1,
    padding: T.spacing.lg,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: T.colors.surface,
    padding: T.spacing.xl,
    borderRadius: T.radius.xl,
    alignItems: 'center',
    ...T.shadow.md,
  },
  icon: {
    fontSize: 52,
    marginBottom: T.spacing.md,
  },
  title: {
    fontSize: T.fontSize.xl,
    fontWeight: '800',
    color: T.colors.text,
    textAlign: 'center',
    marginBottom: T.spacing.sm,
  },
  description: {
    fontSize: T.fontSize.base,
    color: T.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: T.spacing.xl,
  },
  spinner: {
    marginBottom: T.spacing.lg,
  },
  stateTitle: {
    fontSize: T.fontSize.lg,
    fontWeight: '700',
    color: T.colors.text,
    textAlign: 'center',
    marginBottom: T.spacing.xs,
  },
  stateSubtitle: {
    fontSize: T.fontSize.sm,
    color: T.colors.textSecondary,
    textAlign: 'center',
    marginBottom: T.spacing.xl,
  },
  receiptBox: {
    width: '100%',
    backgroundColor: T.colors.bg,
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    marginBottom: T.spacing.xl,
    borderWidth: 1,
    borderColor: T.colors.border,
  },
  receiptRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: T.colors.border,
  },
  receiptLabel: {
    fontSize: T.fontSize.sm,
    color: T.colors.textSecondary,
    fontWeight: '500',
  },
  receiptValue: {
    fontSize: T.fontSize.sm,
    color: T.colors.text,
    fontWeight: '700',
  },
  monoText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: T.fontSize.xs,
  },
  errorBox: {
    backgroundColor: T.colors.errorBg,
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    borderWidth: 1,
    borderColor: '#fecdd3',
    marginBottom: T.spacing.lg,
    width: '100%',
  },
  errorText: {
    color: T.colors.error,
    fontSize: T.fontSize.sm,
    textAlign: 'center',
    fontWeight: '500',
  },
  helpText: {
    color: T.colors.textMuted,
    fontSize: T.fontSize.xs,
    textAlign: 'center',
    marginBottom: T.spacing.lg,
  },
  primaryBtn: {
    backgroundColor: T.colors.primary,
    borderRadius: T.radius.md,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.xl,
    width: '100%',
    alignItems: 'center',
    ...T.shadow.sm,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: T.fontSize.base,
    fontWeight: '700',
  },
  outlineBtn: {
    marginTop: T.spacing.sm,
    paddingVertical: T.spacing.md,
    width: '100%',
    alignItems: 'center',
  },
  outlineBtnText: {
    color: T.colors.textSecondary,
    fontSize: T.fontSize.base,
    fontWeight: '600',
  },
  cancelLink: {
    padding: T.spacing.sm,
  },
  cancelLinkText: {
    color: T.colors.error,
    fontSize: T.fontSize.sm,
    fontWeight: '600',
  },
});
