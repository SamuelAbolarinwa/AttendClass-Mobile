import * as Keychain from 'react-native-keychain';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Buffer } from 'buffer';
import { DiagnosticLogger } from './DiagnosticLogger';
import { LocalApprovalService, LocalApprovalErrorCode } from './LocalApprovalService';

export interface DeviceKeyRecord {
  publicKeyBase64: string;
  createdAt: string;
  accountId: string;
}

export interface SignAttendanceParams {
  accountId: string;
  terminalId: string;
  sessionId: string;
  challengeBase64: string;
  studentId: string;
  matricNumber: string;
  timestamp: number;
  eventId: string;
}

export interface SignAttendanceResult {
  success: boolean;
  signatureBase64?: string;
  publicKeyBase64?: string;
  canonicalMessage?: string;
  errorCode?: LocalApprovalErrorCode | 'KEY_NOT_FOUND' | 'SIGNING_FAILED';
  errorMessage?: string;
}

export class AttendanceSigner {
  public static getServiceKey(accountId: string): string {
    return `attendclass_device_key_${accountId}`;
  }

  /**
   * Generates a new Ed25519 keypair and saves the private key seed into
   * the OS Keystore/Keychain protected with biometric/passcode access control.
   */
  public static async generateAndStoreDeviceKey(
    accountId: string,
    _promptTitle = 'Secure Device Enrolment',
  ): Promise<{ publicKeyBase64: string }> {
    const service = this.getServiceKey(accountId);

    // 1. Generate 32-byte cryptographically secure private key seed
    const privKeyBytes = ed25519.utils.randomSecretKey();
    const pubKeyBytes = ed25519.getPublicKey(privKeyBytes);

    const privKeyHex = Buffer.from(privKeyBytes).toString('hex');
    const publicKeyBase64 = Buffer.from(pubKeyBytes).toString('base64');

    const payload = JSON.stringify({
      privKeyHex,
      publicKeyBase64,
      accountId,
      createdAt: new Date().toISOString(),
    });

    // 2. Determine best access control for device
    const caps = await LocalApprovalService.checkCapabilities();
    let accessControl: Keychain.ACCESS_CONTROL = Keychain.ACCESS_CONTROL.DEVICE_PASSCODE;

    if (caps.capability === 'BIOMETRICS_AVAILABLE') {
      accessControl = Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE;
    }

    try {
      await Keychain.setGenericPassword(accountId, payload, {
        service,
        accessControl,
        securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });

      DiagnosticLogger.info('SIGNER', 'Device signing key stored securely in Keychain', {
        accountId,
        accessControl,
      });

      return { publicKeyBase64 };
    } catch (err: unknown) {
      // Fallback without biometric constraint if device lacks biometric/passcode hardware
      DiagnosticLogger.warn('SIGNER', 'Secure hardware store fallback', {
        error: err instanceof Error ? err.message : String(err),
      });

      await Keychain.setGenericPassword(accountId, payload, {
        service,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });

      return { publicKeyBase64 };
    }
  }

  /**
   * Check if a device signing key is enrolled for this account.
   */
  public static async hasEnrolledDeviceKey(accountId: string): Promise<boolean> {
    const service = this.getServiceKey(accountId);
    try {
      const exists = await Keychain.hasGenericPassword({ service });
      return exists;
    } catch {
      return false;
    }
  }

  /**
   * Delete device signing key upon explicit revocation or account removal.
   */
  public static async clearDeviceKey(accountId: string): Promise<void> {
    const service = this.getServiceKey(accountId);
    try {
      await Keychain.resetGenericPassword({ service });
      DiagnosticLogger.info('SIGNER', 'Cleared device signing key', { accountId });
    } catch (err: unknown) {
      DiagnosticLogger.warn('SIGNER', 'Failed clearing device key', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Builds canonical message to sign for attendance transaction.
   * Format: v1|{terminal_id}|{session_id}|{challenge}|{student_id}|{matric_number}|{timestamp}|{event_id}
   */
  public static buildCanonicalMessage(params: SignAttendanceParams): string {
    return [
      'v1',
      params.terminalId,
      params.sessionId,
      params.challengeBase64,
      params.studentId,
      params.matricNumber,
      params.timestamp.toString(),
      params.eventId,
    ].join('|');
  }

  /**
   * Request OS authentication (biometric / passcode) to access key,
   * then sign the canonical attendance challenge.
   */
  public static async signAttendance(
    params: SignAttendanceParams,
    authPrompt = 'Authenticate to confirm attendance check-in',
  ): Promise<SignAttendanceResult> {
    const service = this.getServiceKey(params.accountId);

    let creds: false | Keychain.UserCredentials;
    try {
      creds = await Keychain.getGenericPassword({
        service,
        authenticationPrompt: {
          title: 'Authorise Attendance Check-in',
          subtitle: authPrompt,
          description: `Signing attendance for ${params.matricNumber} at terminal ${params.terminalId}`,
        },
      });
    } catch (authError: unknown) {
      const classified = LocalApprovalService.classifyAuthError(authError);
      DiagnosticLogger.logError(params.eventId, 'SIGN_AUTH', classified.code, classified.message);
      return {
        success: false,
        errorCode: classified.code,
        errorMessage: classified.message,
      };
    }

    if (!creds || !creds.password) {
      DiagnosticLogger.logError(params.eventId, 'SIGN_KEY', 'KEY_NOT_FOUND', 'Device key not found');
      return {
        success: false,
        errorCode: 'KEY_NOT_FOUND',
        errorMessage: 'Device key not found in secure storage. Enrolment required.',
      };
    }

    try {
      const record = JSON.parse(creds.password);
      const privKeyBytes = Buffer.from(record.privKeyHex, 'hex');
      const canonicalMsg = this.buildCanonicalMessage(params);
      const msgBytes = Buffer.from(canonicalMsg, 'utf-8');

      // Ed25519 signing
      const sigBytes = ed25519.sign(msgBytes, privKeyBytes);
      const signatureBase64 = Buffer.from(sigBytes).toString('base64');

      DiagnosticLogger.logStage(params.eventId, 'SIGN_SUCCESS', 'Transaction signed successfully');

      return {
        success: true,
        signatureBase64,
        publicKeyBase64: record.publicKeyBase64,
        canonicalMessage: canonicalMsg,
      };
    } catch (signErr: unknown) {
      const msg = signErr instanceof Error ? signErr.message : String(signErr);
      DiagnosticLogger.logError(params.eventId, 'SIGN_EXEC', 'SIGNING_FAILED', msg);
      return {
        success: false,
        errorCode: 'SIGNING_FAILED',
        errorMessage: `Failed to generate digital signature: ${msg}`,
      };
    }
  }

  /**
   * Utility to verify Ed25519 signature
   */
  public static verifySignature(
    canonicalMessage: string,
    signatureBase64: string,
    publicKeyBase64: string,
  ): boolean {
    try {
      const msgBytes = Buffer.from(canonicalMessage, 'utf-8');
      const sigBytes = Buffer.from(signatureBase64, 'base64');
      const pubBytes = Buffer.from(publicKeyBase64, 'base64');
      return ed25519.verify(sigBytes, msgBytes, pubBytes);
    } catch {
      return false;
    }
  }
}
