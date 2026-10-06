import { Buffer } from 'buffer';
import { AttendanceSigner } from '../src/services/AttendanceSigner';
import { DeviceSecurityService } from '../src/services/DeviceSecurityService';

describe('Activation Code & Device Enrolment Contract', () => {
  beforeEach(() => {
    DeviceSecurityService.__resetSimulatedKeyStore();
  });

  test('generates valid ECDSA P-256 signing keypair and produces verifiable DER signatures', async () => {
    const studentId = 'test-student-id-99';
    const keyMeta = await AttendanceSigner.generateAndStoreDeviceKey(studentId);

    expect(keyMeta.publicKeyDerBase64).toBeDefined();
    expect(keyMeta.algorithm).toBe('ECDSA_P256_SHA256');
    expect(keyMeta.credentialId).toBeDefined();

    // 91-byte X.509 SPKI DER format for ECDSA P-256
    const pubKeyBytes = Buffer.from(keyMeta.publicKeyDerBase64, 'base64');
    expect(pubKeyBytes.length).toBe(91);

    const params = {
      accountId: studentId,
      studentId,
      matricNumber: '2021/1/9999CP',
      terminalId: 'ESP32_TERM_01',
      sessionId: 'sess_oct06',
      challengeBase64: Buffer.from('32bytesrandomchallengeforble1234').toString('base64'),
      timestamp: 1791298800,
      eventId: 'evt-unique-1234',
    };

    const signResult = await AttendanceSigner.signAttendance(params);
    expect(signResult.success).toBe(true);
    expect(signResult.signatureBase64).toBeDefined();
    expect(signResult.algorithm).toBe('ECDSA_P256_SHA256');

    // ASN.1 DER signature for P-256 is typically 70-72 bytes
    const sigBytes = Buffer.from(signResult.signatureBase64!, 'base64');
    expect(sigBytes.length).toBeGreaterThanOrEqual(68);
    expect(sigBytes.length).toBeLessThanOrEqual(74);

    // Verify signature cryptographically
    const isValid = AttendanceSigner.verifySignature(
      signResult.canonicalMessage!,
      signResult.signatureBase64!,
      keyMeta.publicKeyDerBase64,
    );
    expect(isValid).toBe(true);
  });

  test('canonical message format matches versioned protocol specification', () => {
    const params = {
      accountId: 'student-1',
      studentId: 'student-uuid',
      matricNumber: '2021/1/12345CP',
      terminalId: 'TERM_01',
      sessionId: 'sess_1',
      challengeBase64: 'challenge_b64',
      timestamp: 1700000000,
      eventId: 'event-uuid-1',
    };

    const canonical = AttendanceSigner.buildCanonicalMessage(params, 'cred_abc123');
    expect(canonical).toBe(
      'v1|submission|event-uuid-1|cred_abc123|v1|ECDSA_P256_SHA256|student-uuid|2021/1/12345CP|TERM_01|sess_1|challenge_b64|1700000000|phone_os',
    );
  });

  test('safe staging preserves active key if replacement enrolment fails', async () => {
    const accountId = 'student-replace-test';

    // 1. Existing working key
    const initialKey = await AttendanceSigner.generateAndStoreDeviceKey(accountId, false);
    expect(await AttendanceSigner.hasEnrolledDeviceKey(accountId)).toBe(true);

    // 2. Stage a new key for replacement
    const stagingKey = await AttendanceSigner.generateAndStoreDeviceKey(accountId, true);
    expect(stagingKey.publicKeyDerBase64).not.toBe(initialKey.publicKeyDerBase64);

    // 3. Simulated enrolment failure: discard staging key
    await AttendanceSigner.discardStagingKey(accountId);

    // 4. Verify initial active key is still completely functional
    const signResult = await AttendanceSigner.signAttendance({
      accountId,
      studentId: accountId,
      matricNumber: '2021/1/11111CP',
      terminalId: 'TERM_01',
      sessionId: 'sess_1',
      challengeBase64: 'challenge_b64_val_123',
      timestamp: 1700000000,
      eventId: 'evt-1',
    });
    expect(signResult.success).toBe(true);
    const valid = AttendanceSigner.verifySignature(
      signResult.canonicalMessage!,
      signResult.signatureBase64!,
      initialKey.publicKeyDerBase64,
    );
    expect(valid).toBe(true);
  });

  test('prevents account switching key leakage across distinct accounts', async () => {
    const accountA = 'student-A';
    const accountB = 'student-B';

    await AttendanceSigner.generateAndStoreDeviceKey(accountA, false);
    expect(await AttendanceSigner.hasEnrolledDeviceKey(accountA)).toBe(true);
    expect(await AttendanceSigner.hasEnrolledDeviceKey(accountB)).toBe(false);

    // Account B cannot sign using Account A's key
    const resultB = await AttendanceSigner.signAttendance({
      accountId: accountB,
      studentId: accountB,
      matricNumber: '2021/1/BBBBB',
      terminalId: 'TERM_01',
      sessionId: 'sess_1',
      challengeBase64: 'challenge_b64_val_123',
      timestamp: 1700000000,
      eventId: 'evt-b',
    });
    expect(resultB.success).toBe(false);
    expect(resultB.errorCode).toBe('KEY_NOT_FOUND');
  });
});
