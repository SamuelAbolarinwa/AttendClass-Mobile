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
import { AttendanceService } from '../attendance/AttendanceService';
import { AttendanceState, StateMachineContext } from '../attendance/AttendanceStateMachine';
import { AttendanceReceipt } from '../services/AttendanceReceiptStorage';
import { ClassroomQRPayload } from '../qr/QRPayload';
import { T } from '../theme/tokens';

export default function CheckInScreen({ navigation, route }: any) {
  const { account, isDeviceEnrolled } = useAuth();
  const qrPayload = route?.params?.qrPayload as ClassroomQRPayload | undefined;

  const [state, setState] = useState<AttendanceState>(qrPayload ? 'QR_VALIDATED' : 'READY');
  const [statusMessage, setStatusMessage] = useState(
    qrPayload ? 'Classroom QR validated. Ready to connect.' : 'Ready to scan classroom QR',
  );
  const [context, setContext] = useState<StateMachineContext>(qrPayload ? { qrPayload } : {});
  const [receipt, setReceipt] = useState<AttendanceReceipt | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const attendanceServiceRef = useRef<AttendanceService | null>(null);

  useEffect(() => {
    attendanceServiceRef.current = new AttendanceService();
    return () => {
      attendanceServiceRef.current?.destroy();
    };
  }, []);

  const runAttendanceWithPayload = useCallback(
    async (payload: ClassroomQRPayload) => {
      if (!account) return;
      setIsProcessing(true);
      setErrorMessage(null);
      setReceipt(null);

      const service = attendanceServiceRef.current || new AttendanceService();

      const result = await service.executeCheckIn({
        accountId: account.id,
        studentId: account.id,
        matricNumber: account.matric_number || account.identifier,
        qrPayload: payload,
        rssiThreshold: -90,
        onStateChange: (newState, message, newCtx) => {
          setState(newState);
          setStatusMessage(message);
          setContext(newCtx);
        },
      });

      setIsProcessing(false);
      setState(result.state);

      if (result.success && result.receipt) {
        setReceipt(result.receipt);
      } else if (!result.success) {
        setErrorMessage(result.errorMessage || 'Check-in failed');
      }
    },
    [account],
  );

  // Auto-start check-in when screen mounts with a valid scanned QR payload
  useEffect(() => {
    if (qrPayload && !isProcessing && state === 'QR_VALIDATED') {
      runAttendanceWithPayload(qrPayload);
    }
  }, [qrPayload, isProcessing, state, runAttendanceWithPayload]);

  const handleRetry = () => {
    if (qrPayload) {
      runAttendanceWithPayload(qrPayload);
    } else {
      navigation.navigate('QRScanner');
    }
  };

  const renderContent = () => {
    if (!isDeviceEnrolled) {
      return (
        <View style={styles.card}>
          <Text style={styles.icon}>📱</Text>
          <Text style={styles.title}>Device Enrolment Required</Text>
          <Text style={styles.description}>
            This phone is not enrolled as your authorised attendance device. Attendance requires an authorised phone with hardware-backed key protection.
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

    if (!qrPayload && state === 'READY') {
      return (
        <View style={styles.card}>
          <Text style={styles.icon}>📷</Text>
          <Text style={styles.title}>Scan Classroom QR</Text>
          <Text style={styles.description}>
            Each classroom has a permanent QR code on the wall or attendance box. Scan the code to connect to the classroom terminal over Bluetooth.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.navigate('QRScanner')}
          >
            <Text style={styles.primaryBtnText}>Scan Attendance QR</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (state === 'SUCCESS' && receipt) {
      return (
        <View style={styles.card}>
          <Text style={styles.icon}>✅</Text>
          <Text style={styles.title}>Attendance Confirmed</Text>
          <Text style={styles.description}>
            Your attendance has been cryptographically signed using your phone&apos;s fingerprint and durably saved by the classroom terminal.
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
            {context.courseId ? (
              <View style={styles.receiptRow}>
                <Text style={styles.receiptLabel}>Course:</Text>
                <Text style={styles.receiptValue}>{context.courseId}</Text>
              </View>
            ) : null}
            {context.sessionId ? (
              <View style={styles.receiptRow}>
                <Text style={styles.receiptLabel}>Session ID:</Text>
                <Text style={styles.receiptValue}>{context.sessionId}</Text>
              </View>
            ) : null}
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Recorded Date:</Text>
              <Text style={styles.receiptValue}>{receipt.lagosDate}</Text>
            </View>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Official Time:</Text>
              <Text style={styles.receiptValue}>
                {receipt.terminalSavedAtIso
                  ? new Date(receipt.terminalSavedAtIso).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : receipt.attendanceTimeIso}
              </Text>
            </View>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Receipt Status:</Text>
              <Text style={[styles.receiptValue, { color: T.colors.success }]}>
                ✓ Verified ESP32 Receipt
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
            onPress={() => navigation.navigate('Dashboard')}
          >
            <Text style={styles.primaryBtnText}>Return to Dashboard</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (state === 'ALREADY_RECORDED') {
      return (
        <View style={styles.card}>
          <Text style={styles.icon}>📋</Text>
          <Text style={styles.title}>Attendance Already Recorded</Text>
          <Text style={styles.description}>
            Your attendance for this course session ({receipt?.lagosDate || 'today'}) has already been verified and durably recorded.
          </Text>
          {receipt && (
            <View style={styles.receiptBox}>
              <View style={styles.receiptRow}>
                <Text style={styles.receiptLabel}>Course:</Text>
                <Text style={styles.receiptValue}>{context.courseId || 'Enrolled Course'}</Text>
              </View>
              <View style={styles.receiptRow}>
                <Text style={styles.receiptLabel}>Terminal:</Text>
                <Text style={styles.receiptValue}>{receipt.terminalId}</Text>
              </View>
              <View style={styles.receiptRow}>
                <Text style={styles.receiptLabel}>Status:</Text>
                <Text style={[styles.receiptValue, { color: T.colors.success }]}>
                  Recorded &amp; Confirmed
                </Text>
              </View>
            </View>
          )}
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.navigate('Dashboard')}
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (state === 'FAILED') {
      return (
        <View style={styles.card}>
          <Text style={styles.icon}>❌</Text>
          <Text style={styles.title}>Check-In Not Completed</Text>
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMessage || 'An error occurred during verification.'}</Text>
          </View>
          <Text style={styles.helpText}>
            Ensure you are near the classroom attendance terminal with Bluetooth turned on.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleRetry}>
            <Text style={styles.primaryBtnText}>Try Again</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.outlineBtn}
            onPress={() => navigation.navigate('Dashboard')}
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
            {state === 'SEARCHING_DEVICE' && 'Searching for Terminal…'}
            {state === 'CONNECTING_BLE' && 'Connecting to Terminal…'}
            {state === 'WAITING_FOR_CHALLENGE' && 'Obtaining Challenge…'}
            {state === 'VERIFYING_ESP' && 'Verifying Terminal…'}
            {state === 'WAITING_FOR_BIOMETRIC' && 'Confirm Your Fingerprint…'}
            {state === 'SIGNING_CHALLENGE' && 'Signing Challenge…'}
            {state === 'SENDING_PROOF' && 'Sending Proof…'}
            {state === 'WAITING_FOR_RESULT' && 'Saving Attendance…'}
            {state === 'VERIFYING_RECEIPT' && 'Authenticating Receipt…'}
            {state === 'RECOVERING_RESULT' && 'Recovering Attendance…'}
          </Text>
          <Text style={styles.stateSubtitle}>{statusMessage}</Text>
          {context.courseId ? (
            <View style={styles.courseTag}>
              <Text style={styles.courseTagText}>Course: {context.courseId}</Text>
            </View>
          ) : null}
          <TouchableOpacity
            style={styles.cancelLink}
            onPress={() => {
              attendanceServiceRef.current?.cancel();
              setIsProcessing(false);
              setState('CANCELLED');
            }}
          >
            <Text style={styles.cancelLinkText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return null;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor={T.colors.bg} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Classroom Check-In</Text>
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
    fontSize: T.fontSize.sm,
    color: T.colors.primary,
    fontWeight: '700',
  },
  headerTitle: {
    fontSize: T.fontSize.base,
    fontWeight: '800',
    color: T.colors.text,
  },
  headerSpacer: {
    width: 48,
  },
  scrollContent: {
    padding: T.spacing.lg,
    justifyContent: 'center',
    flexGrow: 1,
  },
  card: {
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.xl,
    padding: T.spacing.xl,
    alignItems: 'center',
    ...T.shadow.md,
  },
  icon: {
    fontSize: 54,
    marginBottom: T.spacing.md,
  },
  title: {
    fontSize: T.fontSize.xl,
    fontWeight: '800',
    color: T.colors.text,
    marginBottom: T.spacing.sm,
    textAlign: 'center',
  },
  description: {
    fontSize: T.fontSize.sm,
    color: T.colors.textSecondary,
    textAlign: 'center',
    marginBottom: T.spacing.lg,
    lineHeight: 20,
  },
  spinner: {
    marginVertical: T.spacing.lg,
  },
  stateTitle: {
    fontSize: T.fontSize.lg,
    fontWeight: '800',
    color: T.colors.text,
    marginBottom: T.spacing.xs,
    textAlign: 'center',
  },
  stateSubtitle: {
    fontSize: T.fontSize.sm,
    color: T.colors.textSecondary,
    textAlign: 'center',
    marginBottom: T.spacing.md,
  },
  courseTag: {
    backgroundColor: T.colors.primary100,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: T.radius.full,
    marginBottom: T.spacing.md,
  },
  courseTagText: {
    color: T.colors.primary,
    fontWeight: '700',
    fontSize: T.fontSize.xs,
  },
  cancelLink: {
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
  },
  cancelLinkText: {
    color: T.colors.textMuted,
    fontSize: T.fontSize.sm,
    fontWeight: '600',
  },
  receiptBox: {
    width: '100%',
    backgroundColor: T.colors.bg,
    borderRadius: T.radius.lg,
    padding: T.spacing.md,
    marginVertical: T.spacing.md,
    borderWidth: 1,
    borderColor: T.colors.border,
  },
  receiptRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  receiptLabel: {
    fontSize: T.fontSize.xs,
    color: T.colors.textSecondary,
    fontWeight: '600',
  },
  receiptValue: {
    fontSize: T.fontSize.xs,
    color: T.colors.text,
    fontWeight: '700',
  },
  monoText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  primaryBtn: {
    width: '100%',
    backgroundColor: T.colors.primary,
    paddingVertical: T.spacing.md,
    borderRadius: T.radius.lg,
    alignItems: 'center',
    marginTop: T.spacing.sm,
    ...T.shadow.sm,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: T.fontSize.base,
    fontWeight: '700',
  },
  outlineBtn: {
    width: '100%',
    backgroundColor: 'transparent',
    paddingVertical: T.spacing.md,
    borderRadius: T.radius.lg,
    alignItems: 'center',
    marginTop: T.spacing.sm,
    borderWidth: 1,
    borderColor: T.colors.border,
  },
  outlineBtnText: {
    color: T.colors.textSecondary,
    fontSize: T.fontSize.base,
    fontWeight: '600',
  },
  errorBox: {
    width: '100%',
    backgroundColor: T.colors.errorBg,
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  errorText: {
    color: T.colors.error,
    fontSize: T.fontSize.sm,
    textAlign: 'center',
  },
  helpText: {
    fontSize: T.fontSize.xs,
    color: T.colors.textMuted,
    textAlign: 'center',
    marginBottom: T.spacing.md,
  },
});
