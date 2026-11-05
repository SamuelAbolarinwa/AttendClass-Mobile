import { BleConnectionManager } from '../ble/BleConnectionManager';
import {
  BleProtocol,
  BleHelloMessage,
  BleChallengeMessage,
  BleProofMessage,
  BleResultMessage,
  BleGetResultMessage,
} from '../ble/BleProtocol';
import { ClassroomQRPayload } from '../qr/QRPayload';
import { QRValidator } from '../qr/QRValidator';
import { TerminalTrustStore } from '../services/TerminalTrustStore';
import { DeviceSecurityService } from '../services/DeviceSecurityService';
import {
  AttendanceReceiptStorage,
  AttendanceReceipt,
  PendingReconciliationRecord,
} from '../services/AttendanceReceiptStorage';
import { AttendanceStateMachine, AttendanceState, StateMachineContext } from './AttendanceStateMachine';
import { DiagnosticLogger } from '../services/DiagnosticLogger';

export interface ExecuteAttendanceParams {
  accountId: string;
  studentId: string;
  matricNumber: string;
  qrPayload: ClassroomQRPayload;
  rssiThreshold?: number;
  onStateChange?: (state: AttendanceState, message: string, context: StateMachineContext) => void;
}

export interface AttendanceExecutionResult {
  success: boolean;
  state: AttendanceState;
  receipt?: AttendanceReceipt;
  errorCode?: string;
  errorMessage?: string;
  requestId?: string;
}

export class AttendanceService {
  private bleManager: BleConnectionManager;
  private stateMachine: AttendanceStateMachine;
  private isRunning = false;

  constructor(bleManager?: BleConnectionManager) {
    this.bleManager = bleManager || new BleConnectionManager();
    this.stateMachine = new AttendanceStateMachine();
  }

  public cancel(reason = 'Check-in cancelled by user'): void {
    this.bleManager.cancel();
    this.stateMachine.cancel(reason);
    this.isRunning = false;
  }

  public destroy(): void {
    this.bleManager.destroy();
    this.isRunning = false;
  }

  public getStateMachine(): AttendanceStateMachine {
    return this.stateMachine;
  }

  /**
   * Execute complete end-to-end device-bound offline attendance check-in.
   */
  public async executeCheckIn(
    params: ExecuteAttendanceParams,
  ): Promise<AttendanceExecutionResult> {
    if (this.isRunning) {
      return {
        success: false,
        state: 'FAILED',
        errorCode: 'CONCURRENT_CHECKIN_IN_PROGRESS',
        errorMessage: 'An attendance check-in operation is already in progress.',
      };
    }
    this.isRunning = true;

    // Forward state changes to caller listener if supplied
    if (params.onStateChange) {
      this.stateMachine.subscribe((state, ctx, msg) => {
        if (params.onStateChange) {
          params.onStateChange(state, msg, ctx);
        }
      });
    }

    const txId = DiagnosticLogger.startTransaction('OFFLINE_ATTENDANCE_V1');
    DiagnosticLogger.logStage(txId, 'START', 'Starting offline BLE attendance transaction', {
      studentId: params.studentId,
      matricNumber: params.matricNumber,
      targetDevice: params.qrPayload.device_id,
    });

    const requestId = BleProtocol.generateRequestId();

    try {
      // ── Step 0: Validate QR Payload and Trust Store ─────────────────────────
      this.stateMachine.transition('QR_VALIDATED', {
        qrPayload: params.qrPayload,
        deviceId: params.qrPayload.device_id,
      });

      const terminalPubkey = TerminalTrustStore.getTerminalPublicKey(
        params.qrPayload.device_id,
      );
      if (!terminalPubkey) {
        const err = `UNTRUSTED_TERMINAL: Classroom terminal "${params.qrPayload.device_id}" is not in the institutional trust store.`;
        this.stateMachine.fail('UNTRUSTED_TERMINAL', err);
        return { success: false, state: 'FAILED', errorCode: 'UNTRUSTED_TERMINAL', errorMessage: err };
      }

      const expectedFp = QRValidator.computeKeyFingerprint(terminalPubkey);
      if (
        params.qrPayload.device_key_fingerprint !== expectedFp &&
        !expectedFp.startsWith(params.qrPayload.device_key_fingerprint) &&
        !params.qrPayload.device_key_fingerprint.startsWith(expectedFp)
      ) {
        const err = 'FINGERPRINT_MISMATCH: Terminal fingerprint does not match institutional trust registry.';
        this.stateMachine.fail('FINGERPRINT_MISMATCH', err);
        return { success: false, state: 'FAILED', errorCode: 'FINGERPRINT_MISMATCH', errorMessage: err };
      }

      // ── Step 1: Check Local Device Enrolment ───────────────────────────────
      const hasKey = await DeviceSecurityService.hasActiveKey(params.accountId);
      if (!hasKey) {
        const err = 'This phone is not registered as your attendance device. Please enrol your phone in Settings.';
        this.stateMachine.fail('DEVICE_NOT_ENROLLED', err);
        return { success: false, state: 'FAILED', errorCode: 'DEVICE_NOT_ENROLLED', errorMessage: err };
      }

      const studentPubKey = await DeviceSecurityService.getActivePublicKey(params.accountId);
      const credentialId =
        (await DeviceSecurityService.getActiveCredentialId(params.accountId)) ||
        (studentPubKey ? DeviceSecurityService.computeCredentialId(studentPubKey) : 'cred_active');

      // ── Step 2: Search for Classroom ESP32 over BLE ───────────────────────
      this.stateMachine.transition('SEARCHING_DEVICE');
      DiagnosticLogger.logStage(txId, 'BLE_SEARCH', `Scanning for ${params.qrPayload.device_id}`);

      const device = await this.bleManager.scanForTerminal({
        targetDeviceId: params.qrPayload.device_id,
        targetServiceUuid: params.qrPayload.service_uuid,
        timeoutMs: 15000,
        rssiThreshold: params.rssiThreshold ?? -90,
      });

      // ── Step 3: Connect over BLE and Negotiate MTU ────────────────────────
      this.stateMachine.transition('CONNECTING_BLE');
      DiagnosticLogger.logStage(txId, 'BLE_CONNECT', `Connecting to ${device.id}`);

      const connected = await this.bleManager.connect(device);
      const service = await this.bleManager.resolveGattService(
        connected,
        params.qrPayload.service_uuid,
      );

      // Setup incoming message promise and reassembly
      let challengeResolver: (msg: BleChallengeMessage) => void;
      let challengeRejecter: (err: Error) => void;
      const challengePromise = new Promise<BleChallengeMessage>((resolve, reject) => {
        challengeResolver = resolve;
        challengeRejecter = reject;
      });

      let resultResolver: (msg: BleResultMessage) => void;
      let resultRejecter: (err: Error) => void;
      const resultPromise = new Promise<BleResultMessage>((resolve, reject) => {
        resultResolver = resolve;
        resultRejecter = reject;
      });

      // ── Step 4: Subscribe to notifications BEFORE sending first write ──────
      await this.bleManager.subscribeToNotifications(
        connected,
        service,
        (msg) => {
          if (msg.type === 'CHALLENGE') {
            challengeResolver(msg);
          } else if (msg.type === 'RESULT') {
            resultResolver(msg);
          }
        },
        (err) => {
          challengeRejecter(err);
          resultRejecter(err);
        },
      );

      // ── Step 5: Send HELLO message ─────────────────────────────────────────
      this.stateMachine.transition('WAITING_FOR_CHALLENGE');
      const clientNonce = BleProtocol.generateClientNonce();

      const helloMsg: BleHelloMessage = {
        v: 1,
        type: 'HELLO',
        request_id: requestId,
        device_id: params.qrPayload.device_id,
        credential_id: credentialId,
        client_nonce: clientNonce,
      };

      await this.bleManager.sendMessage(connected, service, helloMsg);

      // ── Step 6: Await CHALLENGE from ESP32 with timeout (15s) ──────────────
      const challengeTimeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('CHALLENGE_TIMEOUT: Timed out waiting for challenge from classroom device.')),
          15000,
        ),
      );

      const challenge = await Promise.race([challengePromise, challengeTimeout]);

      // ── Step 7: Cryptographically Verify ESP32 Identity ────────────────────
      this.stateMachine.transition('VERIFYING_ESP', { challenge });

      // Verify echoed identifiers
      if (challenge.request_id !== requestId) {
        throw new Error('REQUEST_ID_MISMATCH: Terminal returned mismatched request_id.');
      }
      if (challenge.client_nonce !== clientNonce) {
        throw new Error('CLIENT_NONCE_MISMATCH: Terminal did not echo client nonce correctly.');
      }
      if (challenge.device_id !== params.qrPayload.device_id) {
        throw new Error('DEVICE_ID_MISMATCH: Terminal returned different device_id.');
      }

      // Verify cryptographic signature over canonical challenge
      const challengeCanonical = BleProtocol.buildChallengeCanonicalString(challenge);
      const isEspSigValid = DeviceSecurityService.verifySignature(
        challengeCanonical,
        challenge.esp_signature,
        terminalPubkey,
      );

      if (!isEspSigValid) {
        throw new Error('FORGED_ESP_CHALLENGE: Classroom terminal signature verification failed.');
      }

      DiagnosticLogger.logStage(txId, 'ESP_VERIFIED', 'Terminal identity verified', {
        courseId: challenge.course_id,
        sessionId: challenge.session_id,
      });

      this.stateMachine.updateContext({
        courseId: challenge.course_id,
        sessionId: challenge.session_id,
      });

      // ── Step 8: Native Biometric Authentication Prompt ──────────────────────
      this.stateMachine.transition('WAITING_FOR_BIOMETRIC');

      const proofCanonical = BleProtocol.buildProofCanonicalString({
        deviceId: params.qrPayload.device_id,
        credentialId,
        requestId,
        sessionId: challenge.session_id,
        courseId: challenge.course_id,
        clientNonce,
        challenge: challenge.challenge,
      });

      this.stateMachine.transition('SIGNING_CHALLENGE');

      const promptSubtitle = `Course: ${challenge.course_id} • Session: ${challenge.session_id}`;
      const signRes = await DeviceSecurityService.signData(
        params.accountId,
        proofCanonical,
        'Verify Fingerprint to Mark Attendance',
        promptSubtitle,
      );

      if (!signRes.success || !signRes.signatureDerBase64) {
        throw new Error(
          signRes.errorMessage || 'Biometric authentication was cancelled or failed.',
        );
      }

      // ── Step 9: Send Signed PROOF to ESP32 ──────────────────────────────────
      this.stateMachine.transition('SENDING_PROOF');

      const proofMsg: BleProofMessage = {
        v: 1,
        type: 'PROOF',
        request_id: requestId,
        credential_id: credentialId,
        algorithm: 'ES256',
        signature_der: signRes.signatureDerBase64,
      };

      // Pre-persist pending reconciliation BEFORE sending so outcome can be recovered if connection drops
      const submissionPayloadForStorage = {
        version: 1,
        event_id: requestId,
        credential_id: credentialId,
        credential_version: 'v1',
        algorithm: 'ECDSA_P256_SHA256' as const,
        student_id: params.studentId,
        matric_number: params.matricNumber,
        terminal_id: params.qrPayload.device_id,
        session_id: challenge.session_id,
        challenge: challenge.challenge,
        timestamp: Math.floor(Date.now() / 1000),
        timestamp_source: 'phone_os' as const,
        public_key: studentPubKey || '',
        signature: signRes.signatureDerBase64,
      };

      const pendingRec: PendingReconciliationRecord = {
        eventId: requestId,
        accountId: params.accountId,
        studentId: params.studentId,
        matricNumber: params.matricNumber,
        terminalId: params.qrPayload.device_id,
        sessionId: challenge.session_id,
        submissionPayload: submissionPayloadForStorage,
        createdAtIso: new Date().toISOString(),
      };
      await AttendanceReceiptStorage.savePendingReconciliation(pendingRec);

      await this.bleManager.sendMessage(connected, service, proofMsg);

      // ── Step 10: Await RESULT from ESP32 with Timeout & Recovery ───────────
      this.stateMachine.transition('WAITING_FOR_RESULT');

      let resultMsg: BleResultMessage;
      const resultTimeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('RESULT_TIMEOUT: Waiting for confirmation timed out.')),
          15000,
        ),
      );

      try {
        resultMsg = await Promise.race([resultPromise, resultTimeout]);
      } catch (timeoutOrDropErr) {
        // Attempt disconnection recovery via GET_RESULT
        DiagnosticLogger.warn(
          'RECOVERY',
          `Connection interrupted before result received (${String(timeoutOrDropErr)}); attempting GET_RESULT recovery`,
        );
        this.stateMachine.transition('RECOVERING_RESULT');

        const recoveryMsg: BleGetResultMessage = {
          v: 1,
          type: 'GET_RESULT',
          request_id: requestId,
          credential_id: credentialId,
        };

        try {
          await this.bleManager.sendMessage(connected, service, recoveryMsg);
          resultMsg = await Promise.race([
            resultPromise,
            new Promise<never>((_, r) =>
              setTimeout(() => r(new Error('Recovery query timed out.')), 8000),
            ),
          ]);
        } catch {
          throw new Error(
            'VERIFICATION_STATUS_UNKNOWN: Attendance was transmitted, but confirmation could not be verified due to a disconnection. Please re-scan to confirm.',
          );
        }
      }

      // ── Step 11: Cryptographically Verify Attendance Receipt Signature ──────
      this.stateMachine.transition('VERIFYING_RECEIPT', { result: resultMsg });

      if (resultMsg.status === 'REJECTED') {
        throw new Error(
          resultMsg.error_message ||
            `Classroom terminal rejected check-in (${resultMsg.error_code || 'REJECTED'}).`,
        );
      }

      const receiptCanonical = BleProtocol.buildReceiptCanonicalString(resultMsg);
      const isReceiptSigValid = DeviceSecurityService.verifySignature(
        receiptCanonical,
        resultMsg.receipt_signature,
        terminalPubkey,
      );

      if (!isReceiptSigValid) {
        throw new Error('FORGED_RECEIPT: Official attendance receipt signature could not be verified.');
      }

      // ── Step 12: Durable Storage & Confirmation ─────────────────────────────
      const nowSec = Math.floor(Date.now() / 1000);
      const savedReceipt: AttendanceReceipt = {
        eventId: resultMsg.event_id || requestId,
        accountId: params.accountId,
        studentId: params.studentId,
        matricNumber: params.matricNumber,
        terminalId: params.qrPayload.device_id,
        sessionId: resultMsg.session_id || challenge.session_id,
        attendanceTimestamp: nowSec,
        phoneTimeConfidence: 'provisional',
        attendanceTimeIso: new Date(nowSec * 1000).toISOString(),
        localReceiptTimeIso: new Date().toISOString(),
        terminalSavedAtIso: resultMsg.logged_at,
        terminalTimeConfidence: 'rtc',
        terminalReceiptSignature: resultMsg.receipt_signature,
        submissionDigest: proofCanonical,
        status: 'TERMINAL_CONFIRMED_SD',
        lagosDate: AttendanceReceiptStorage.getLagosDate(nowSec),
      };

      await AttendanceReceiptStorage.saveReceipt(savedReceipt);
      await AttendanceReceiptStorage.clearPendingReconciliation(params.accountId);

      await this.bleManager.disconnect();

      const finalState: AttendanceState =
        resultMsg.status === 'ALREADY_RECORDED' ? 'ALREADY_RECORDED' : 'SUCCESS';

      this.stateMachine.transition(finalState, { receipt: savedReceipt });

      DiagnosticLogger.endTransaction(
        txId,
        true,
        `Attendance successfully completed (${finalState})`,
      );

      return {
        success: true,
        state: finalState,
        receipt: savedReceipt,
        requestId,
      };
    } catch (err: unknown) {
      await this.bleManager.disconnect().catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      DiagnosticLogger.logError(txId, 'EXEC_ERROR', 'FAILED', msg);
      this.stateMachine.fail('CHECKIN_FAILED', msg);
      return {
        success: false,
        state: 'FAILED',
        errorCode: 'CHECKIN_FAILED',
        errorMessage: msg,
        requestId,
      };
    } finally {
      this.isRunning = false;
    }
  }
}
