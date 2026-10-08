import { BleTransportService } from './BleTransportService';
import { AttendanceSigner } from './AttendanceSigner';
import { AttendanceReceiptStorage, AttendanceReceipt, PendingReconciliationRecord } from './AttendanceReceiptStorage';
import { TerminalTrustStore } from './TerminalTrustStore';
import { DiagnosticLogger } from './DiagnosticLogger';
import { AttendanceSubmissionPayload } from './AttendanceProtocol';

export type AttendanceFlowState =
  | 'IDLE'
  | 'CHECKING_STATUS'
  | 'RECONCILING_PENDING'
  | 'SCANNING_TERMINAL'
  | 'CONNECTING_TERMINAL'
  | 'FETCHING_CHALLENGE'
  | 'VERIFYING_TERMINAL'
  | 'LOCAL_APPROVAL'
  | 'SIGNING'
  | 'SUBMITTING_ATTENDANCE'
  | 'AWAITING_SD_ACK'
  | 'VERIFYING_RECEIPT'
  | 'SUCCESS'
  | 'ALREADY_LOGGED'
  | 'FAILED';

export interface AttendanceTransactionParams {
  accountId: string;
  studentId: string;
  matricNumber: string;
  rssiThreshold?: number;
  onStateChange?: (state: AttendanceFlowState, message: string) => void;
}

export interface AttendanceTransactionResult {
  success: boolean;
  state: AttendanceFlowState;
  receipt?: AttendanceReceipt;
  errorCode?: string;
  errorMessage?: string;
  transactionId?: string;
}

export class AttendanceManager {
  private transport: BleTransportService;
  private isExecuting = false;

  constructor(transport?: BleTransportService) {
    this.transport = transport || new BleTransportService();
  }

  public cancel(): void {
    this.transport.cancel();
  }

  public destroy(): void {
    this.transport.destroy();
  }

  public async executeAttendance(
    params: AttendanceTransactionParams,
  ): Promise<AttendanceTransactionResult> {
    if (this.isExecuting) {
      return {
        success: false,
        state: 'FAILED',
        errorCode: 'CONCURRENT_CHECKIN_IN_PROGRESS',
        errorMessage: 'An attendance check-in is already in progress.',
      };
    }
    this.isExecuting = true;

    const notify = (state: AttendanceFlowState, message: string) => {
      if (params.onStateChange) params.onStateChange(state, message);
    };

    const txId = DiagnosticLogger.startTransaction('ATTENDANCE_CHECKIN');
    DiagnosticLogger.logStage(txId, 'START', 'Starting attendance check-in transaction', {
      studentId: params.studentId,
      matricNumber: params.matricNumber,
    });

    try {
      // ── Step 1: Check if already logged today ────────────────────────────
      notify('CHECKING_STATUS', 'Checking today’s attendance records...');
      const todayCheck = await AttendanceReceiptStorage.hasLoggedToday(params.accountId);
      if (todayCheck.logged && todayCheck.receipt) {
        DiagnosticLogger.endTransaction(txId, true, 'Already logged today');
        notify('ALREADY_LOGGED', 'Attendance already confirmed for today.');
        return {
          success: true,
          state: 'ALREADY_LOGGED',
          receipt: todayCheck.receipt,
          transactionId: txId,
        };
      }

      // ── Step 2: Check if device is enrolled ──────────────────────────────
      const isEnrolled = await AttendanceSigner.hasEnrolledDeviceKey(params.accountId);
      if (!isEnrolled) {
        const err = 'Device is not enrolled. Please complete device activation first.';
        DiagnosticLogger.logError(txId, 'PRECHECK', 'DEVICE_NOT_ENROLLED', err);
        notify('FAILED', err);
        return {
          success: false,
          state: 'FAILED',
          errorCode: 'DEVICE_NOT_ENROLLED',
          errorMessage: err,
          transactionId: txId,
        };
      }

      // ── Step 3: Check for pending reconciliation from dropped connection ──
      const pendingRecon = await AttendanceReceiptStorage.getPendingReconciliation(params.accountId);
      if (pendingRecon) {
        notify('RECONCILING_PENDING', 'Reconciling previously submitted attendance...');
        DiagnosticLogger.info('RECONCILIATION', 'Attempting reconciliation for existing event', {
          eventId: pendingRecon.eventId,
        });
      }

      // ── Step 4: Scan for nearby authorized BLE Terminal ─────────────────
      notify('SCANNING_TERMINAL', 'Searching for class attendance terminal...');
      DiagnosticLogger.logStage(txId, 'BLE_SCAN', 'Scanning for terminal');

      const terminalDevice = await this.transport.scanForTerminal({
        timeoutMs: 15000,
        rssiThreshold: params.rssiThreshold ?? -85,
      });

      DiagnosticLogger.logStage(txId, 'BLE_FOUND', `Found terminal: ${terminalDevice.name || terminalDevice.id}`);

      // ── Step 5: Connect to terminal ─────────────────────────────────────
      notify('CONNECTING_TERMINAL', 'Connecting to attendance terminal...');
      const connected = await this.transport.connect(terminalDevice);

      // ── Step 6: Fetch & cryptographically verify terminal challenge ─────
      notify('FETCHING_CHALLENGE', 'Requesting fresh attendance challenge...');
      const challenge = await this.transport.fetchChallenge(connected);

      notify('VERIFYING_TERMINAL', 'Verifying terminal authenticity...');
      const challengeVerification = TerminalTrustStore.verifyTerminalChallenge(challenge);
      if (!challengeVerification.valid) {
        await this.transport.disconnect();
        const err = challengeVerification.reason || 'Terminal verification failed';
        DiagnosticLogger.logError(txId, 'AUTH_TERMINAL', 'TERMINAL_VERIFICATION_FAILED', err);
        notify('FAILED', err);
        return {
          success: false,
          state: 'FAILED',
          errorCode: 'TERMINAL_VERIFICATION_FAILED',
          errorMessage: err,
          transactionId: txId,
        };
      }

      DiagnosticLogger.logStage(txId, 'CHALLENGE_VERIFIED', 'Terminal challenge verified', {
        terminalId: challenge.terminal_id,
        sessionId: challenge.session_id,
        timeConfidence: challenge.time_confidence,
      });

      // ── Step 7: Local Approval & Sign Challenge (or reuse pending) ───────
      let submission: AttendanceSubmissionPayload;
      let submissionDigest: string;

      if (pendingRecon && pendingRecon.sessionId === challenge.session_id) {
        // Reconcile using previously signed submission and exact same event_id!
        submission = pendingRecon.submissionPayload;
        submissionDigest = TerminalTrustStore.computeSubmissionDigest(
          AttendanceSigner.buildCanonicalMessage(
            {
              accountId: params.accountId,
              studentId: params.studentId,
              matricNumber: params.matricNumber,
              terminalId: submission.terminal_id,
              sessionId: submission.session_id,
              challengeBase64: submission.challenge,
              timestamp: submission.timestamp,
              eventId: submission.event_id,
            },
            submission.credential_id,
          ),
        );
        DiagnosticLogger.info('RECONCILIATION', 'Reusing signed submission with same eventId', {
          eventId: submission.event_id,
        });
      } else {
        notify('LOCAL_APPROVAL', 'Please authenticate to confirm attendance...');
        const eventId = Math.random().toString(36).substring(2, 15) + '-' + Date.now().toString(36);
        const timestamp = Math.floor(Date.now() / 1000); // Phone provisional time

        const signRes = await AttendanceSigner.signAttendance({
          accountId: params.accountId,
          studentId: params.studentId,
          matricNumber: params.matricNumber,
          terminalId: challenge.terminal_id,
          sessionId: challenge.session_id,
          challengeBase64: challenge.challenge,
          timestamp,
          eventId,
        });

        if (!signRes.success || !signRes.signatureBase64 || !signRes.canonicalMessage) {
          await this.transport.disconnect();
          DiagnosticLogger.logError(
            txId,
            'SIGNING',
            signRes.errorCode || 'SIGN_FAILED',
            signRes.errorMessage || 'Signing failed or was cancelled',
          );
          notify('FAILED', signRes.errorMessage || 'Signing was cancelled or failed.');
          return {
            success: false,
            state: 'FAILED',
            errorCode: signRes.errorCode || 'SIGN_FAILED',
            errorMessage: signRes.errorMessage || 'Signing was cancelled or failed.',
            transactionId: txId,
          };
        }

        submissionDigest = TerminalTrustStore.computeSubmissionDigest(signRes.canonicalMessage);

        submission = {
          version: 1,
          event_id: eventId,
          credential_id: signRes.credentialId || 'unknown_cred',
          credential_version: signRes.credentialVersion || 'v1',
          algorithm: 'ECDSA_P256_SHA256',
          student_id: params.studentId,
          matric_number: params.matricNumber,
          terminal_id: challenge.terminal_id,
          session_id: challenge.session_id,
          challenge: challenge.challenge,
          timestamp,
          timestamp_source: 'phone_os',
          public_key: signRes.publicKeyBase64 || '',
          signature: signRes.signatureBase64,
        };
      }

      // ── Step 8: Pre-persist event identity and recovery state BEFORE transmission ───────────
      // Guarantees an app crash, disconnect, or power loss cannot generate a new duplicate eventId
      const pendingRec: PendingReconciliationRecord = {
        eventId: submission.event_id,
        accountId: params.accountId,
        studentId: params.studentId,
        matricNumber: params.matricNumber,
        terminalId: submission.terminal_id,
        sessionId: submission.session_id,
        submissionPayload: submission,
        createdAtIso: new Date().toISOString(),
      };
      await AttendanceReceiptStorage.savePendingReconciliation(pendingRec);

      notify('SUBMITTING_ATTENDANCE', 'Sending signed attendance response...');
      notify('AWAITING_SD_ACK', 'Awaiting terminal durable save confirmation...');

      const ack = await this.transport.submitAttendanceAndAwaitAck(connected, submission, 12000);

      // ── Step 9: Authenticate terminal durable receipt ─────────────────────
      notify('VERIFYING_RECEIPT', 'Authenticating terminal durable receipt...');
      const receiptVerification = TerminalTrustStore.verifyTerminalReceipt(ack, submissionDigest);
      if (!receiptVerification.valid) {
        await this.transport.disconnect();
        const err = receiptVerification.reason || 'Terminal receipt could not be authenticated';
        DiagnosticLogger.logError(txId, 'RECEIPT_AUTH', 'RECEIPT_VERIFICATION_FAILED', err);
        notify('FAILED', err);
        return {
          success: false,
          state: 'FAILED',
          errorCode: 'RECEIPT_VERIFICATION_FAILED',
          errorMessage: err,
          transactionId: txId,
        };
      }

      DiagnosticLogger.logStage(txId, 'ACK_VERIFIED', 'Durable save receipt cryptographically verified', {
        sdPersisted: ack.sd_persisted,
        recordIndex: ack.record_index,
      });

      // ── Step 10: Persist local receipt with timestamp provenance ──────────
      const receipt: AttendanceReceipt = {
        eventId: submission.event_id,
        accountId: params.accountId,
        studentId: params.studentId,
        matricNumber: params.matricNumber,
        terminalId: challenge.terminal_id,
        sessionId: challenge.session_id,
        attendanceTimestamp: submission.timestamp,
        phoneTimeConfidence: 'provisional',
        attendanceTimeIso: new Date(submission.timestamp * 1000).toISOString(),
        localReceiptTimeIso: new Date().toISOString(),
        terminalSavedAtIso: ack.saved_at ? new Date(ack.saved_at * 1000).toISOString() : undefined,
        terminalTimeConfidence: challenge.time_confidence,
        sdRecordIndex: ack.record_index,
        terminalReceiptSignature: ack.signature,
        submissionDigest,
        status: 'TERMINAL_CONFIRMED_SD',
        lagosDate: AttendanceReceiptStorage.getLagosDate(submission.timestamp),
      };

      await AttendanceReceiptStorage.saveReceipt(receipt);
      // Clear any resolved reconciliation state
      await AttendanceReceiptStorage.clearPendingReconciliation(params.accountId);

      // Clean disconnect
      await this.transport.disconnect();

      DiagnosticLogger.endTransaction(txId, true, 'Attendance successfully confirmed with mutual authentication');
      notify('SUCCESS', 'Attendance recorded successfully!');

      return {
        success: true,
        state: 'SUCCESS',
        receipt,
        transactionId: txId,
      };
    } catch (err: unknown) {
      await this.transport.disconnect();
      const msg = err instanceof Error ? err.message : String(err);
      DiagnosticLogger.logError(txId, 'EXEC_ERROR', 'FAILED', msg);
      notify('FAILED', msg);
      return {
        success: false,
        state: 'FAILED',
        errorCode: 'TRANSACTION_FAILED',
        errorMessage: msg,
        transactionId: txId,
      };
    } finally {
      this.isExecuting = false;
    }
  }
}
