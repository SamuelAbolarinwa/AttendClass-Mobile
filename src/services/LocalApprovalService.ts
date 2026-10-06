import * as Keychain from 'react-native-keychain';
import { DiagnosticLogger } from './DiagnosticLogger';

export type LocalAuthCapability =
  | 'BIOMETRICS_AVAILABLE'
  | 'PASSCODE_ONLY'
  | 'NO_ENROLLED_CREDENTIALS'
  | 'HARDWARE_UNAVAILABLE';

export interface LocalAuthCapabilityResult {
  capability: LocalAuthCapability;
  biometryType: Keychain.BIOMETRY_TYPE | null;
  hasPasscode: boolean;
  canAuthenticate: boolean;
  message: string;
}

export type LocalApprovalErrorCode =
  | 'AUTH_CANCELLED'
  | 'AUTH_LOCKOUT'
  | 'AUTH_FAILED'
  | 'NO_CREDENTIAL'
  | 'HARDWARE_NOT_SUPPORTED'
  | 'UNKNOWN_ERROR';

export interface LocalApprovalResult {
  success: boolean;
  errorCode?: LocalApprovalErrorCode;
  errorMessage?: string;
}

export class LocalApprovalService {
  /**
   * Check OS capabilities for biometric / screen lock authentication at runtime.
   */
  public static async checkCapabilities(): Promise<LocalAuthCapabilityResult> {
    try {
      const biometryType = await Keychain.getSupportedBiometryType();
      const hasPasscode = await Keychain.isPasscodeAuthAvailable();
      let canAuthenticate = false;

      try {
        canAuthenticate = await Keychain.canImplyAuthentication({
          authenticationType: Keychain.AUTHENTICATION_TYPE.DEVICE_PASSCODE_OR_BIOMETRICS,
        });
      } catch {
        canAuthenticate = !!biometryType || hasPasscode;
      }

      if (biometryType && canAuthenticate) {
        return {
          capability: 'BIOMETRICS_AVAILABLE',
          biometryType,
          hasPasscode,
          canAuthenticate: true,
          message: `Biometric authentication available (${biometryType}).`,
        };
      }

      if (hasPasscode) {
        return {
          capability: 'PASSCODE_ONLY',
          biometryType: null,
          hasPasscode: true,
          canAuthenticate: true,
          message: 'Device screen-lock passcode / PIN available.',
        };
      }

      return {
        capability: 'NO_ENROLLED_CREDENTIALS',
        biometryType: null,
        hasPasscode: false,
        canAuthenticate: false,
        message: 'No biometric or screen lock passcode enrolled on device.',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      DiagnosticLogger.warn('LOCAL_APPROVAL', 'Failed checking capabilities', { error: msg });
      return {
        capability: 'HARDWARE_UNAVAILABLE',
        biometryType: null,
        hasPasscode: false,
        canAuthenticate: false,
        message: `Authentication hardware check failed: ${msg}`,
      };
    }
  }

  /**
   * Classify an error thrown during OS authentication prompt.
   */
  public static classifyAuthError(error: unknown): { code: LocalApprovalErrorCode; message: string } {
    const rawMsg = error instanceof Error ? error.message : String(error);
    const lower = rawMsg.toLowerCase();

    if (lower.includes('cancel') || lower.includes('user cancelled') || lower.includes('user canceled')) {
      return { code: 'AUTH_CANCELLED', message: 'Authentication was cancelled by the user.' };
    }

    if (lower.includes('lockout') || lower.includes('too many attempts')) {
      return { code: 'AUTH_LOCKOUT', message: 'Too many failed attempts. Biometrics temporarily locked.' };
    }

    if (lower.includes('no credentials') || lower.includes('not enrolled') || lower.includes('passcode not set')) {
      return { code: 'NO_CREDENTIAL', message: 'No biometric or secure screen lock enrolled on this device.' };
    }

    if (lower.includes('hardware') || lower.includes('not supported') || lower.includes('unavailable')) {
      return { code: 'HARDWARE_NOT_SUPPORTED', message: 'Authentication hardware unavailable.' };
    }

    return { code: 'AUTH_FAILED', message: rawMsg || 'Local authentication failed.' };
  }
}
