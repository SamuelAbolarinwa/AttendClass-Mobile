import { DeviceSecurityService, DeviceKeyMetadata } from './DeviceSecurityService';
import { AttendanceProtocol } from './AttendanceProtocol';
import { DiagnosticLogger } from './DiagnosticLogger';
import { LocalApprovalErrorCode } from './LocalApprovalService';

export interface SignAttendanceParams {
  accountId: string;
  terminalId: string;
  sessionId: string;
  challengeBase64: string;
  studentId: string;
  matricNumber: string;
  timestamp: number;
  eventId: string;
  credentialId?: string;
}

export interface SignAttendanceResult {
  success: boolean;
  signatureBase64?: string;
  publicKeyBase64?: string;
  credentialId?: string;
  credentialVersion?: string;
  algorithm?: 'ECDSA_P256_SHA256';
  canonicalMessage?: string;
  securityLevel?: string;
  errorCode?: LocalApprovalErrorCode | 'KEY_NOT_FOUND' | 'SIGNING_FAILED';
  errorMessage?: string;
}

export class AttendanceSigner {
  /**
   * Generates a new hardware-backed ECDSA P-256 keypair.
   * If isStaging is true, generates into a provisional staging slot to protect
   * any active working key from premature destruction during replacement.
   */
  public static async generateAndStoreDeviceKey(
    accountId: string,
    isStaging = false,
  ): Promise<DeviceKeyMetadata> {
    return DeviceSecurityService.generateDeviceKey(accountId, isStaging);
  }

  /**
   * Commit staging key to active status after backend registration succeeds.
   */
  public static async commitStagingKey(accountId: string): Promise<void> {
    await DeviceSecurityService.commitStagingKey(accountId);
  }

  /**
   * Discard staging key if backend activation fails.
   */
  public static async discardStagingKey(accountId: string): Promise<void> {
    await DeviceSecurityService.discardStagingKey(accountId);
  }

  /**
   * Check if a device signing key is enrolled for this account.
   */
  public static async hasEnrolledDeviceKey(accountId: string): Promise<boolean> {
    return DeviceSecurityService.hasActiveKey(accountId);
  }

  /**
   * Delete device signing key upon explicit revocation or account removal.
   */
  public static async clearDeviceKey(accountId: string): Promise<void> {
    await DeviceSecurityService.deleteKey(accountId);
  }

  /**
   * Builds canonical message to sign for attendance transaction.
   * Format: v1|submission|{event_id}|{credential_id}|{credential_version}|{algorithm}|{student_id}|{matric_number}|{terminal_id}|{session_id}|{challenge}|{timestamp}|{timestamp_source}
   */
  public static buildCanonicalMessage(
    params: SignAttendanceParams,
    credentialId: string,
  ): string {
    return AttendanceProtocol.buildSubmissionCanonicalString({
      version: 1,
      event_id: params.eventId,
      credential_id: credentialId,
      credential_version: DeviceSecurityService.CREDENTIAL_VERSION,
      algorithm: DeviceSecurityService.ALGORITHM,
      student_id: params.studentId,
      matric_number: params.matricNumber,
      terminal_id: params.terminalId,
      session_id: params.sessionId,
      challenge: params.challengeBase64,
      timestamp: params.timestamp,
      timestamp_source: 'phone_os',
    });
  }

  /**
   * Request OS authentication (biometric / PIN) to unlock key,
   * then sign the canonical attendance challenge.
   */
  public static async signAttendance(
    params: SignAttendanceParams,
    authPrompt = 'Authenticate with biometric or PIN to confirm attendance check-in',
  ): Promise<SignAttendanceResult> {
    const hasKey = await DeviceSecurityService.hasActiveKey(params.accountId);
    if (!hasKey) {
      DiagnosticLogger.logError(params.eventId, 'SIGN_KEY', 'KEY_NOT_FOUND', 'Device key not found');
      return {
        success: false,
        errorCode: 'KEY_NOT_FOUND',
        errorMessage: 'Device key not found in secure storage. Enrolment required.',
      };
    }

    const pubKey = await DeviceSecurityService.getActivePublicKey(params.accountId);
    const credentialId = pubKey
      ? DeviceSecurityService.computeCredentialId(pubKey)
      : params.credentialId || 'cred_unknown';

    const canonicalMsg = this.buildCanonicalMessage(params, credentialId);

    const signRes = await DeviceSecurityService.signData(
      params.accountId,
      canonicalMsg,
      'Authorise Attendance Check-in',
      authPrompt,
    );

    if (!signRes.success || !signRes.signatureDerBase64) {
      DiagnosticLogger.logError(
        params.eventId,
        'SIGN_AUTH',
        signRes.errorCode || 'SIGNING_FAILED',
        signRes.errorMessage || 'Signing failed or was cancelled',
      );
      return {
        success: false,
        errorCode: signRes.errorCode,
        errorMessage: signRes.errorMessage,
      };
    }

    DiagnosticLogger.logStage(params.eventId, 'SIGN_SUCCESS', 'Transaction signed successfully', {
      algorithm: signRes.algorithm,
      securityLevel: signRes.securityLevel,
    });

    return {
      success: true,
      signatureBase64: signRes.signatureDerBase64,
      publicKeyBase64: pubKey || undefined,
      credentialId,
      credentialVersion: DeviceSecurityService.CREDENTIAL_VERSION,
      algorithm: DeviceSecurityService.ALGORITHM,
      canonicalMessage: canonicalMsg,
      securityLevel: signRes.securityLevel,
    };
  }

  /**
   * Utility to verify ECDSA P-256 signature
   */
  public static verifySignature(
    canonicalMessage: string,
    signatureBase64: string,
    publicKeyBase64: string,
  ): boolean {
    return DeviceSecurityService.verifySignature(canonicalMessage, signatureBase64, publicKeyBase64);
  }
}
