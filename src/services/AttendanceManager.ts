import { BleTransportService } from './BleTransportService';
import { AttendanceSigner } from './AttendanceSigner';
import { AttendanceReceiptStorage, AttendanceReceipt } from './AttendanceReceiptStorage';
import { DiagnosticLogger } from './DiagnosticLogger';
import { AttendanceSubmissionPayload } from './AttendanceProtocol';

export type AttendanceFlowState =
  | 'IDLE'
  | 'CHECKING_STATUS'
  | 'SCANNING_TERMINAL'
  | 'CONNECTING_TERMINAL'
  | 'FETCHING_CHALLENGE'
  | 'LOCAL_APPROVAL'
  | 'SIGNING'
  | 'SUBMITTING_ATTENDANCE'
  | 'AWAITING_SD_ACK'
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
    const notify = (state: AttendanceFlowState, message: string) => {
      if (params.onStateChange) params.onStateChange(state, message);
    };

    const txId = DiagnosticLogger.startTransaction('ATTENDANCE_CHECKIN');
    DiagnosticLogger.logStage(txId, 'START', 'Starting attendance transaction', {
      studentId: params.studentId,
      matricNumber: params.matricNumber,
    });

    try {
      // 1. Check if already logged today
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

      // 2. Check if device is enrolled
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

      // 3. Scan for nearby BLE Terminal
      notify('SCANNING_TERMINAL', 'Searching for class attendance terminal...');
      DiagnosticLogger.logStage(txId, 'BLE_SCAN', 'Scanning for terminal');

      const terminalDevice = await this.transport.scanForTerminal({
        timeoutMs: 15000,
        rssiThreshold: params.rssiThreshold ?? -85,
      });

      DiagnosticLogger.logStage(txId, 'BLE_FOUND', `Found terminal: ${terminalDevice.name || terminalDevice.id}`);

      // 4. Connect to terminal
      notify('CONNECTING_TERMINAL', 'Connecting to attendance terminal...');
      const connected = await this.transport.connect(terminalDevice);

      // 5. Fetch fresh challenge
      notify('FETCHING_CHALLENGE', 'Requesting fresh attendance challenge...');
      const challenge = await this.transport.fetchChallenge(connected);
      DiagnosticLogger.logStage(txId, 'CHALLENGE_RECEIVED', 'Challenge received', {
        terminalId: challenge.terminal_id,
        sessionId: challenge.session_id,
      });

      // 6. Request OS Local Approval & Sign Challenge
      notify('LOCAL_APPROVAL', 'Please authenticate to confirm attendance...');
      const eventId = Math.random().toString(36).substring(2, 15) + '-' + Date.now().toString(36);
      const timestamp = Math.floor(Date.now() / 1000);

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

      if (!signRes.success || !signRes.signatureBase64 || !signRes.publicKeyBase64) {
        await this.transport.disconnect();
        DiagnosticLogger.logError(txId, 'SIGNING', signRes.errorCode || 'SIGN_FAILED', signRes.errorMessage || 'Signing failed');
        notify('FAILED', signRes.errorMessage || 'Signing was cancelled or failed.');
        return {
          success: false,
          state: 'FAILED',
          errorCode: signRes.errorCode || 'SIGN_FAILED',
          errorMessage: signRes.errorMessage || 'Signing was cancelled or failed.',
          transactionId: txId,
        };
      }

      // 7. Assemble submission packet
      notify('SUBMITTING_ATTENDANCE', 'Sending signed attendance response...');
      const submission: AttendanceSubmissionPayload = {
        version: 1,
        event_id: eventId,
        student_id: params.studentId,
        matric_number: params.matricNumber,
        terminal_id: challenge.terminal_id,
        session_id: challenge.session_id,
        challenge: challenge.challenge,
        timestamp,
        timestamp_source: 'phone_os',
        public_key: signRes.publicKeyBase64,
        signature: signRes.signatureBase64,
      };

      // 8. Submit and wait for durable SD persistence ACK
      notify('AWAITING_SD_ACK', 'Awaiting terminal durable save confirmation...');
      const ack = await this.transport.submitAttendanceAndAwaitAck(connected, submission, 12000);

      DiagnosticLogger.logStage(txId, 'ACK_RECEIVED', 'Durable save acknowledged by terminal', {
        sdPersisted: ack.sd_persisted,
        recordIndex: ack.record_index,
      });

      // 9. Persist local receipt
      const receipt: AttendanceReceipt = {
        eventId,
        accountId: params.accountId,
        studentId: params.studentId,
        matricNumber: params.matricNumber,
        terminalId: challenge.terminal_id,
        sessionId: challenge.session_id,
        attendanceTimestamp: timestamp,
        attendanceTimeIso: new Date(timestamp * 1000).toISOString(),
        localReceiptTimeIso: new Date().toISOString(),
        terminalSavedAtIso: ack.saved_at ? new Date(ack.saved_at * 1000).toISOString() : undefined,
        sdRecordIndex: ack.record_index,
        status: 'DEVICE_CONFIRMED',
        lagosDate: AttendanceReceiptStorage.getLagosDate(timestamp),
      };

      await AttendanceReceiptStorage.saveReceipt(receipt);

      // 10. Clean disconnect
      await this.transport.disconnect();

      DiagnosticLogger.endTransaction(txId, true, 'Attendance successfully confirmed and saved to SD');
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
    }
  }
}
