/**
 * AttendClass BLE Protocol v1 Specification
 *
 * Implements bidirectional challenge-response mutual cryptographic authentication
 * between Student Phone and Classroom ESP32 Terminal over Bluetooth Low Energy.
 */

import { Buffer } from 'buffer';

// Primary AttendClass BLE GATT UUIDs
export const ATTENDCLASS_PRIMARY_SERVICE_UUID = '4e67a100-1234-5678-abcd-0123456789ab';
export const ATTENDCLASS_WRITE_CHAR_UUID = '4e67a101-1234-5678-abcd-0123456789ab';
export const ATTENDCLASS_NOTIFY_CHAR_UUID = '4e67a102-1234-5678-abcd-0123456789ab';

// Backward-compatible fallback / alias service UUIDs
export const ATTENDCLASS_LEGACY_SERVICE_UUID = '0000ff10-0000-1000-8000-00805f9b34fb';
export const ATTENDCLASS_LEGACY_CHALLENGE_CHAR_UUID = '0000ff11-0000-1000-8000-00805f9b34fb';
export const ATTENDCLASS_LEGACY_SUBMISSION_CHAR_UUID = '0000ff12-0000-1000-8000-00805f9b34fb';
export const ATTENDCLASS_LEGACY_ACK_CHAR_UUID = '0000ff13-0000-1000-8000-00805f9b34fb';

export const PROTOCOL_VERSION = 1;
export const CHECKIN_DOMAIN_SEPARATOR = 'ATTENDCLASS_CHECKIN_V1';
export const CHALLENGE_DOMAIN_SEPARATOR = 'ATTENDCLASS_CHALLENGE_V1';
export const RECEIPT_DOMAIN_SEPARATOR = 'ATTENDCLASS_RECEIPT_V1';

// Step A: HELLO (Phone -> ESP32)
export interface BleHelloMessage {
  v: 1;
  type: 'HELLO';
  request_id: string;
  device_id: string;
  credential_id: string;
  client_nonce: string; // 16 cryptographically random bytes (hex or base64)
}

// Step B: CHALLENGE (ESP32 -> Phone)
export interface BleChallengeMessage {
  v: 1;
  type: 'CHALLENGE';
  request_id: string;
  device_id: string;
  credential_id: string;
  session_id: string;
  course_id: string;
  client_nonce: string; // echoed client nonce
  challenge: string; // 32 cryptographically random bytes (hex or base64)
  valid_for_ms: number; // e.g. 30000 (30s)
  esp_key_id: string; // e.g. "esp-lt101-v1"
  esp_signature: string; // ECDSA P-256 signature Base64
}

// Step D: PROOF (Phone -> ESP32)
export interface BleProofMessage {
  v: 1;
  type: 'PROOF';
  request_id: string;
  credential_id: string;
  algorithm: 'ES256' | 'ECDSA_P256_SHA256';
  signature_der: string; // ECDSA signature Base64
}

// Step E: RESULT (ESP32 -> Phone)
export interface BleResultMessage {
  v: 1;
  type: 'RESULT';
  request_id: string;
  status: 'SUCCESS' | 'ALREADY_RECORDED' | 'REJECTED';
  student_id: string;
  session_id: string;
  event_id: string;
  logged_at: string; // ISO 8601 or RFC3339 timestamp
  receipt_signature: string; // ESP32 signature Base64
  error_code?: string;
  error_message?: string;
}

// Step G: Recovery GET_RESULT (Phone -> ESP32)
export interface BleGetResultMessage {
  v: 1;
  type: 'GET_RESULT';
  request_id: string;
  credential_id: string;
}

export type BleProtocolMessage =
  | BleHelloMessage
  | BleChallengeMessage
  | BleProofMessage
  | BleResultMessage
  | BleGetResultMessage;

export class BleProtocol {
  /**
   * Generate cryptographically secure random client nonce (16 bytes hex).
   */
  public static generateClientNonce(): string {
    const bytes = new Uint8Array(16);
    const cryptoObj = (globalThis as any).crypto;
    if (typeof cryptoObj?.getRandomValues === 'function') {
      cryptoObj.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Buffer.from(bytes).toString('hex');
  }

  /**
   * Generate request identifier for the check-in transaction.
   */
  public static generateRequestId(): string {
    const rnd = Math.random().toString(36).substring(2, 8);
    const ts = Date.now().toString(36).slice(-4);
    return `tx-${rnd}-${ts}`;
  }

  /**
   * Build canonical string for Biometric Proof signature.
   * Bound to:
   * 1. Protocol domain separator: ATTENDCLASS_CHECKIN_V1
   * 2. ESP32 device ID
   * 3. Credential ID
   * 4. Request ID
   * 5. Attendance session ID
   * 6. Course ID
   * 7. Client nonce
   * 8. ESP32-generated challenge
   */
  public static buildProofCanonicalString(params: {
    deviceId: string;
    credentialId: string;
    requestId: string;
    sessionId: string;
    courseId: string;
    clientNonce: string;
    challenge: string;
  }): string {
    return [
      CHECKIN_DOMAIN_SEPARATOR,
      params.deviceId,
      params.credentialId,
      params.requestId,
      params.sessionId,
      params.courseId,
      params.clientNonce,
      params.challenge,
    ].join('|');
  }

  /**
   * Build canonical string for ESP32 Challenge signature verification.
   */
  public static buildChallengeCanonicalString(msg: BleChallengeMessage): string {
    return [
      CHALLENGE_DOMAIN_SEPARATOR,
      msg.device_id,
      msg.credential_id,
      msg.request_id,
      msg.session_id,
      msg.course_id,
      msg.client_nonce,
      msg.challenge,
      msg.valid_for_ms.toString(),
      msg.esp_key_id,
    ].join('|');
  }

  /**
   * Build canonical string for ESP32 Receipt signature verification.
   */
  public static buildReceiptCanonicalString(msg: BleResultMessage): string {
    return [
      RECEIPT_DOMAIN_SEPARATOR,
      msg.request_id,
      msg.status,
      msg.student_id,
      msg.session_id,
      msg.event_id,
      msg.logged_at,
    ].join('|');
  }

  /**
   * Safe JSON parse and validation of incoming BLE message.
   */
  public static parseMessage(rawText: string): BleProtocolMessage {
    let obj: any;
    try {
      obj = JSON.parse(rawText);
    } catch {
      throw new Error(`INVALID_JSON_MESSAGE: Message payload is not valid JSON (${rawText.slice(0, 50)})`);
    }

    if (!obj || typeof obj !== 'object') {
      throw new Error('INVALID_MESSAGE: Message must be a JSON object');
    }

    if (obj.v !== 1) {
      throw new Error(`UNSUPPORTED_VERSION: Message version ${obj.v} is not supported`);
    }

    const type = obj.type;
    switch (type) {
      case 'HELLO':
      case 'CHALLENGE':
      case 'PROOF':
      case 'RESULT':
      case 'GET_RESULT':
        return obj as BleProtocolMessage;
      default:
        throw new Error(`UNKNOWN_MESSAGE_TYPE: Unrecognized protocol message type "${type}"`);
    }
  }

  /**
   * Serialize protocol message to UTF-8 string.
   */
  public static serializeMessage(msg: BleProtocolMessage): string {
    return JSON.stringify(msg);
  }
}
