import { Buffer } from 'buffer';
import { AttendanceSigner } from '../src/services/AttendanceSigner';

describe('Activation Code & Device Enrolment Contract', () => {
  test('generates valid Ed25519 signing keypair and produces verifiable signatures', async () => {
    const studentId = 'test-student-id-99';
    const { publicKeyBase64 } = await AttendanceSigner.generateAndStoreDeviceKey(studentId);

    expect(publicKeyBase64).toBeDefined();
    // 32-byte Ed25519 public key base64 length is 44 characters
    const pubKeyBytes = Buffer.from(publicKeyBase64, 'base64');
    expect(pubKeyBytes.length).toBe(32);

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

    // Verify 64-byte Ed25519 signature
    const sigBytes = Buffer.from(signResult.signatureBase64!, 'base64');
    expect(sigBytes.length).toBe(64);

    // Verify signature cryptographically
    const isValid = AttendanceSigner.verifySignature(
      signResult.canonicalMessage!,
      signResult.signatureBase64!,
      publicKeyBase64,
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

    const canonical = AttendanceSigner.buildCanonicalMessage(params);
    expect(canonical).toBe('v1|TERM_01|sess_1|challenge_b64|student-uuid|2021/1/12345CP|1700000000|event-uuid-1');
  });
});
