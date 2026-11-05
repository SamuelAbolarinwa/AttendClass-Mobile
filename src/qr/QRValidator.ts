import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';
import { ClassroomQRPayload, QRValidationResult } from './QRPayload';
import { TerminalTrustStore } from '../services/TerminalTrustStore';

export class QRValidator {
  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Compute standard SHA-256 hex fingerprint for a public key (from SPKI DER Base64).
   */
  public static computeKeyFingerprint(pubKeyDerBase64: string): string {
    const raw = Buffer.from(pubKeyDerBase64, 'base64');
    const digest = sha256(raw);
    return Buffer.from(digest).toString('hex').toLowerCase();
  }

  /**
   * Parse and validate raw QR text from camera scanner.
   *
   * @param rawText Scanned string from QR code
   * @param enforceTrustStoreCheck Whether to verify terminal against TerminalTrustStore (default: true)
   */
  public static validate(
    rawText: string,
    enforceTrustStoreCheck = true,
  ): QRValidationResult {
    if (!rawText || typeof rawText !== 'string') {
      return {
        valid: false,
        errorCode: 'INVALID_JSON',
        errorMessage: 'Empty or invalid QR code content.',
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawText.trim());
    } catch {
      return {
        valid: false,
        errorCode: 'INVALID_JSON',
        errorMessage: 'QR code does not contain valid JSON format.',
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      return {
        valid: false,
        errorCode: 'INVALID_JSON',
        errorMessage: 'QR code payload is not a valid JSON object.',
      };
    }

    // Version check
    if (parsed.v !== 1) {
      return {
        valid: false,
        errorCode: 'UNSUPPORTED_VERSION',
        errorMessage: `Unsupported QR code version (${parsed.v}). Expected version 1.`,
      };
    }

    // Type check
    if (parsed.type !== 'attendclass_device') {
      return {
        valid: false,
        errorCode: 'INVALID_TYPE',
        errorMessage: 'QR code is not an AttendClass classroom attendance device.',
      };
    }

    // Required fields check
    if (
      !parsed.device_id ||
      typeof parsed.device_id !== 'string' ||
      parsed.device_id.trim().length === 0
    ) {
      return {
        valid: false,
        errorCode: 'MISSING_FIELDS',
        errorMessage: 'QR code missing device_id field.',
      };
    }

    if (
      !parsed.service_uuid ||
      typeof parsed.service_uuid !== 'string' ||
      !this.UUID_REGEX.test(parsed.service_uuid)
    ) {
      return {
        valid: false,
        errorCode: 'INVALID_UUID',
        errorMessage: 'QR code does not specify a valid 128-bit service UUID.',
      };
    }

    if (
      !parsed.device_key_fingerprint ||
      typeof parsed.device_key_fingerprint !== 'string' ||
      parsed.device_key_fingerprint.trim().length < 32
    ) {
      return {
        valid: false,
        errorCode: 'MISSING_FIELDS',
        errorMessage: 'QR code missing device_key_fingerprint.',
      };
    }

    const payload: ClassroomQRPayload = {
      v: 1,
      type: 'attendclass_device',
      device_id: parsed.device_id.trim(),
      service_uuid: parsed.service_uuid.trim().toLowerCase(),
      device_key_fingerprint: parsed.device_key_fingerprint.trim().toLowerCase(),
    };

    // Trust Store check: ensure the terminal is enrolled in our trusted registry
    if (enforceTrustStoreCheck) {
      const trustedKey = TerminalTrustStore.getTerminalPublicKey(payload.device_id);
      if (!trustedKey) {
        return {
          valid: false,
          errorCode: 'UNTRUSTED_DEVICE',
          errorMessage: `Terminal "${payload.device_id}" is not in the institutional trust store.`,
        };
      }

      const expectedFingerprint = this.computeKeyFingerprint(trustedKey);
      if (
        payload.device_key_fingerprint !== expectedFingerprint &&
        !expectedFingerprint.startsWith(payload.device_key_fingerprint) &&
        !payload.device_key_fingerprint.startsWith(expectedFingerprint)
      ) {
        return {
          valid: false,
          errorCode: 'FINGERPRINT_MISMATCH',
          errorMessage: `Device key fingerprint mismatch for terminal "${payload.device_id}". The QR code may be counterfeit.`,
        };
      }
    }

    return {
      valid: true,
      payload,
    };
  }

  /**
   * Serialize payload into permanent QR format string for printing / provisioning.
   */
  public static encode(payload: ClassroomQRPayload): string {
    return JSON.stringify(payload, null, 2);
  }
}

