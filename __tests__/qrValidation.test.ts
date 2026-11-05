import { QRValidator } from '../src/qr/QRValidator';
import { ClassroomQRPayload } from '../src/qr/QRPayload';
import { TerminalTrustStore } from '../src/services/TerminalTrustStore';

describe('Permanent Classroom QR Code Validation', () => {
  const validTerminalId = 'ESP32-LT101';
  let expectedFingerprint: string;

  beforeEach(() => {
    TerminalTrustStore.__resetTrustStore();
    TerminalTrustStore.initDefaults();

    const pubKey = TerminalTrustStore.getTerminalPublicKey(validTerminalId);
    expect(pubKey).toBeTruthy();
    expectedFingerprint = QRValidator.computeKeyFingerprint(pubKey!);
  });

  test('validates authentic permanent classroom QR payload successfully', () => {
    const rawQr = JSON.stringify({
      v: 1,
      type: 'attendclass_device',
      device_id: validTerminalId,
      service_uuid: '4e67a100-1234-5678-abcd-0123456789ab',
      device_key_fingerprint: expectedFingerprint,
    });

    const result = QRValidator.validate(rawQr);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.device_id).toBe(validTerminalId);
      expect(result.payload.service_uuid).toBe('4e67a100-1234-5678-abcd-0123456789ab');
      expect(result.payload.device_key_fingerprint).toBe(expectedFingerprint);
    }
  });

  test('rejects non-JSON payload', () => {
    const result = QRValidator.validate('NOT_JSON_DATA');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('INVALID_JSON');
    }
  });

  test('rejects unsupported version', () => {
    const rawQr = JSON.stringify({
      v: 2,
      type: 'attendclass_device',
      device_id: validTerminalId,
      service_uuid: '4e67a100-1234-5678-abcd-0123456789ab',
      device_key_fingerprint: expectedFingerprint,
    });

    const result = QRValidator.validate(rawQr);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('UNSUPPORTED_VERSION');
    }
  });

  test('rejects invalid payload type', () => {
    const rawQr = JSON.stringify({
      v: 1,
      type: 'student_credential',
      device_id: validTerminalId,
      service_uuid: '4e67a100-1234-5678-abcd-0123456789ab',
      device_key_fingerprint: expectedFingerprint,
    });

    const result = QRValidator.validate(rawQr);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('INVALID_TYPE');
    }
  });

  test('rejects missing or empty device_id', () => {
    const rawQr = JSON.stringify({
      v: 1,
      type: 'attendclass_device',
      device_id: '   ',
      service_uuid: '4e67a100-1234-5678-abcd-0123456789ab',
      device_key_fingerprint: expectedFingerprint,
    });

    const result = QRValidator.validate(rawQr);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('MISSING_FIELDS');
    }
  });

  test('rejects invalid service UUID', () => {
    const rawQr = JSON.stringify({
      v: 1,
      type: 'attendclass_device',
      device_id: validTerminalId,
      service_uuid: 'invalid-not-a-uuid',
      device_key_fingerprint: expectedFingerprint,
    });

    const result = QRValidator.validate(rawQr);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('INVALID_UUID');
    }
  });

  test('rejects untrusted device not enrolled in TerminalTrustStore', () => {
    const rawQr = JSON.stringify({
      v: 1,
      type: 'attendclass_device',
      device_id: 'ROGUE_ESP32_ATTACKER',
      service_uuid: '4e67a100-1234-5678-abcd-0123456789ab',
      device_key_fingerprint: 'a'.repeat(64),
    });

    const result = QRValidator.validate(rawQr);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('UNTRUSTED_DEVICE');
      expect(result.errorMessage).toContain('not in the institutional trust store');
    }
  });

  test('rejects counterfeit QR with mismatched fingerprint for trusted terminal', () => {
    const fakeFingerprint = 'f'.repeat(64);
    const rawQr = JSON.stringify({
      v: 1,
      type: 'attendclass_device',
      device_id: validTerminalId,
      service_uuid: '4e67a100-1234-5678-abcd-0123456789ab',
      device_key_fingerprint: fakeFingerprint,
    });

    const result = QRValidator.validate(rawQr);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('FINGERPRINT_MISMATCH');
      expect(result.errorMessage).toContain('counterfeit');
    }
  });

  test('encodes and round-trips permanent QR payload correctly', () => {
    const payload: ClassroomQRPayload = {
      v: 1,
      type: 'attendclass_device',
      device_id: validTerminalId,
      service_uuid: '4e67a100-1234-5678-abcd-0123456789ab',
      device_key_fingerprint: expectedFingerprint,
    };

    const encoded = QRValidator.encode(payload);
    const decoded = QRValidator.validate(encoded);
    expect(decoded.valid).toBe(true);
    if (decoded.valid) {
      expect(decoded.payload).toEqual(payload);
    }
  });
});

