/**
 * AttendClass Classroom Terminal Permanent QR Code Specification
 *
 * Permanent classroom QR codes identify physical ESP32 attendance terminals.
 * They do NOT contain student credentials, private keys, TOTP tokens, or session secrets.
 */

export interface ClassroomQRPayload {
  v: number; // Protocol version (currently 1)
  type: 'attendclass_device'; // Device identifier type
  device_id: string; // Physical terminal identifier, e.g. "ESP32-LT101" or "TERM_HALL_A_01"
  service_uuid: string; // 128-bit BLE GATT Service UUID
  device_key_fingerprint: string; // SHA-256 hex digest of terminal public key
}

export type QRValidationResult =
  | {
      valid: true;
      payload: ClassroomQRPayload;
    }
  | {
      valid: false;
      errorCode:
        | 'INVALID_JSON'
        | 'UNSUPPORTED_VERSION'
        | 'INVALID_TYPE'
        | 'MISSING_FIELDS'
        | 'INVALID_UUID'
        | 'UNTRUSTED_DEVICE'
        | 'FINGERPRINT_MISMATCH';
      errorMessage: string;
    };

