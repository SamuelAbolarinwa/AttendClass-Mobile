import { Buffer } from 'buffer';
import { p256 } from '@noble/curves/nist.js';
import { TerminalTrustStore, TerminalChallengePayload } from '../src/services/TerminalTrustStore';
import { TerminalAckPayload } from '../src/services/AttendanceProtocol';
import { DeviceSecurityService } from '../src/services/DeviceSecurityService';
import { AttendanceSigner } from '../src/services/AttendanceSigner';
import { AttendanceProtocol, FrameReassembler } from '../src/services/AttendanceProtocol';
import { AttendanceReceiptStorage, PendingReconciliationRecord } from '../src/services/AttendanceReceiptStorage';
import { isNetworkError } from '../src/contexts/AuthContext';

// Helper to generate a valid ECDSA P-256 keypair for testing
function generateTestP256KeyPair() {
  const priv = p256.utils.randomSecretKey();
  const uncompressed = p256.getPublicKey(priv, false);
  const spkiPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  const fullSpki = Buffer.concat([spkiPrefix, Buffer.from(uncompressed)]);
  const pubBase64 = fullSpki.toString('base64');
  return { priv, pubBase64 };
}

// Helper to sign a message using raw private key into DER Base64
function signMessageDer(message: string, privKey: Uint8Array): string {
  const msgBytes = Buffer.from(message, 'utf-8');
  const compact = p256.sign(msgBytes, privKey);
  const sigObj = p256.Signature.fromBytes(compact);

  function toIntegerDer(num: bigint): number[] {
    let hex = num.toString(16);
    if (hex.length % 2 !== 0) hex = '0' + hex;
    const bytes = Array.from(Buffer.from(hex, 'hex'));
    if (bytes[0] >= 0x80) bytes.unshift(0x00);
    return [0x02, bytes.length, ...bytes];
  }
  const rDer = toIntegerDer(sigObj.r);
  const sDer = toIntegerDer(sigObj.s);
  const body = [...rDer, ...sDer];
  return Buffer.from([0x30, body.length, ...body]).toString('base64');
}

describe('Mutual Cryptographic Authentication & Protocol Integrity', () => {
  const terminalId = 'TERM_HALL_A_01';
  let terminalKeypair: { priv: Uint8Array; pubBase64: string };

  beforeEach(() => {
    TerminalTrustStore.__resetTrustStore();
    DeviceSecurityService.__resetSimulatedKeyStore();

    terminalKeypair = generateTestP256KeyPair();
    TerminalTrustStore.registerTrustedTerminal({
      terminalId,
      publicKeyDerBase64: terminalKeypair.pubBase64,
      institution: 'AttendClass University',
      validFromIso: '2026-01-01T00:00:00Z',
      validUntilIso: '2027-01-01T00:00:00Z',
    });
  });

  // ── 1. Forged and Tampered Terminal Challenges ──────────────────────────────
  test('rejects forged or unsigned terminal challenges', () => {
    const challengePayload: TerminalChallengePayload = {
      version: 1,
      terminal_id: terminalId,
      session_id: 'sess_101',
      challenge: '1234567890abcdef1234567890abcdef',
      terminal_time: 1791298800,
      time_confidence: 'rtc',
      course_code: 'CSC501',
    };

    // Unsigned
    const unsignedResult = TerminalTrustStore.verifyTerminalChallenge(challengePayload);
    expect(unsignedResult.valid).toBe(false);
    expect(unsignedResult.reason).toContain('UNSIGNED_CHALLENGE');

    // Signed with fake/forged signature
    const forgedPayload: TerminalChallengePayload = {
      ...challengePayload,
      signature: Buffer.from('fake_der_signature_bytes_not_matching_key').toString('base64'),
    };
    const forgedResult = TerminalTrustStore.verifyTerminalChallenge(forgedPayload);
    expect(forgedResult.valid).toBe(false);
    expect(forgedResult.reason).toContain('FORGED_TERMINAL_CHALLENGE');
  });

  test('rejects terminal challenge from unknown/untrusted terminal', () => {
    const unknownTerminalId = 'ROGUE_TERMINAL_99';
    const unknownKey = generateTestP256KeyPair();
    const challenge: TerminalChallengePayload = {
      version: 1,
      terminal_id: unknownTerminalId,
      session_id: 'sess_101',
      challenge: 'untrusted_challenge_nonce_123456',
      terminal_time: 1791298800,
      time_confidence: 'rtc',
    };
    const canonical = TerminalTrustStore.buildChallengeCanonicalString(challenge);
    challenge.signature = signMessageDer(canonical, unknownKey.priv);

    const result = TerminalTrustStore.verifyTerminalChallenge(challenge);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('UNTRUSTED_TERMINAL');
  });

  // ── 2. Replayed Terminal Challenges ─────────────────────────────────────────
  test('rejects replayed terminal challenges using the same nonce', () => {
    const nonce = 'unique_nonce_abc1234567890def123';
    const challenge: TerminalChallengePayload = {
      version: 1,
      terminal_id: terminalId,
      session_id: 'sess_101',
      challenge: nonce,
      terminal_time: 1791298800,
      time_confidence: 'rtc',
    };
    const canonical = TerminalTrustStore.buildChallengeCanonicalString(challenge);
    challenge.signature = signMessageDer(canonical, terminalKeypair.priv);

    // First use: valid
    const firstResult = TerminalTrustStore.verifyTerminalChallenge(challenge);
    expect(firstResult.valid).toBe(true);

    // Replayed: rejected immediately!
    const replayResult = TerminalTrustStore.verifyTerminalChallenge(challenge);
    expect(replayResult.valid).toBe(false);
    expect(replayResult.reason).toContain('REPLAYED_CHALLENGE');
  });

  // ── 3. Tampered Signed Submission Fields & Unregistered Student Keys ────────
  test('detects tampered fields in student attendance submission', async () => {
    const studentId = 'student_test_1';
    const keyMeta = await AttendanceSigner.generateAndStoreDeviceKey(studentId);

    const params = {
      accountId: studentId,
      studentId,
      matricNumber: '2021/1/55555CP',
      terminalId,
      sessionId: 'sess_101',
      challengeBase64: 'challenge_nonce_32_bytes_value',
      timestamp: 1791298800,
      eventId: 'evt-signed-001',
    };

    const signResult = await AttendanceSigner.signAttendance(params);
    expect(signResult.success).toBe(true);
    expect(signResult.signatureBase64).toBeDefined();

    // Verification succeeds on authentic message
    expect(
      AttendanceSigner.verifySignature(
        signResult.canonicalMessage!,
        signResult.signatureBase64!,
        keyMeta.publicKeyDerBase64,
      ),
    ).toBe(true);

    // Tampering with matric number invalidates signature
    const tamperedCanonical = signResult.canonicalMessage!.replace('2021/1/55555CP', '2021/1/99999CP');
    expect(
      AttendanceSigner.verifySignature(
        tamperedCanonical,
        signResult.signatureBase64!,
        keyMeta.publicKeyDerBase64,
      ),
    ).toBe(false);

    // Tampering with timestamp invalidates signature
    const tamperedTimeCanonical = signResult.canonicalMessage!.replace('1791298800', '1791299999');
    expect(
      AttendanceSigner.verifySignature(
        tamperedTimeCanonical,
        signResult.signatureBase64!,
        keyMeta.publicKeyDerBase64,
      ),
    ).toBe(false);
  });

  // ── 4. Forged and Tampered Terminal Durable Receipts ────────────────────────
  test('rejects forged receipts, mismatched submission digests, or unpersisted records', () => {
    const eventId = 'evt-ack-101';
    const expectedDigest = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

    const validReceipt: TerminalAckPayload = {
      version: 1,
      event_id: eventId,
      terminal_id: terminalId,
      session_id: 'sess_101',
      submission_digest: expectedDigest,
      status: 'DURABLY_SAVED',
      sd_persisted: true,
      record_index: 42,
      saved_at: 1791298805,
    };
    const canonical = TerminalTrustStore.buildReceiptCanonicalString(validReceipt, expectedDigest);
    validReceipt.signature = signMessageDer(canonical, terminalKeypair.priv);

    // Valid signed receipt passes
    const validRes = TerminalTrustStore.verifyTerminalReceipt(validReceipt, expectedDigest);
    expect(validRes.valid).toBe(true);

    // Receipt acknowledging wrong submission digest is rejected
    const wrongDigestRes = TerminalTrustStore.verifyTerminalReceipt(validReceipt, 'different_digest_hash');
    expect(wrongDigestRes.valid).toBe(false);
    expect(wrongDigestRes.reason).toContain('SUBMISSION_DIGEST_MISMATCH');

    // Receipt with sd_persisted: false is rejected
    const unpersistedReceipt: TerminalAckPayload = {
      ...validReceipt,
      sd_persisted: false,
    };
    const unpersistedRes = TerminalTrustStore.verifyTerminalReceipt(unpersistedReceipt, expectedDigest);
    expect(unpersistedRes.valid).toBe(false);
    expect(unpersistedRes.reason).toContain('TERMINAL_REJECTED');

    // Tampered signature is rejected
    const tamperedReceipt: TerminalAckPayload = {
      ...validReceipt,
      signature: Buffer.from('corrupted_signature_der').toString('base64'),
    };
    const tamperedRes = TerminalTrustStore.verifyTerminalReceipt(tamperedReceipt, expectedDigest);
    expect(tamperedRes.valid).toBe(false);
    expect(tamperedRes.reason).toContain('FORGED_TERMINAL_RECEIPT');
  });

  // ── 5. Fragmented BLE Packet Framing and Safe Reassembly ────────────────────
  test('chunks large payload into bounded frames and safely reassembles them', () => {
    const txIdNum = AttendanceProtocol.eventIdToTxId('tx001122');
    const largePayload = JSON.stringify({
      version: 1,
      event_id: 'evt-large-payload-testing-ble-framing',
      credential_id: 'cred_p256_strongbox_hardware_id_1234567890',
      data: 'A'.repeat(300), // Ensures payload exceeds MTU
    });

    // Test with minimum ATT payload limit (20 bytes for MTU 23)
    const frames = AttendanceProtocol.createBinaryFrames(largePayload, txIdNum, 20);
    expect(frames.length).toBeGreaterThan(1);

    // All frames must have correct magic bytes (0xAC, 0x01) and strictly fit within 20 bytes
    for (const frame of frames) {
      expect(frame[0]).toBe(0xac);
      expect(frame[1]).toBe(0x01);
      expect(frame.length).toBeLessThanOrEqual(20);
    }

    // Reassembly in order
    const reassembler = new FrameReassembler(5000);
    let assembled: { complete: boolean; payload?: string } = { complete: false };

    for (const frame of frames) {
      assembled = reassembler.addFrame(frame);
    }

    expect(assembled.complete).toBe(true);
    expect(assembled.payload).toBe(largePayload);
  });

  test('detects mismatched transactions during packet reassembly', () => {
    const framesA = AttendanceProtocol.createBinaryFrames('payload A', 1001, 20);
    const framesB = AttendanceProtocol.createBinaryFrames('payload B', 2002, 20);

    const reassembler = new FrameReassembler(5000);
    reassembler.addFrame(framesA[0]);

    // Injecting frame from different transaction ID throws
    expect(() => reassembler.addFrame(framesB[0])).toThrow('TRANSACTION_MISMATCH');
  });

  // ── 6. Disconnect After Submission & Reconciliation with Same event_id ───────
  test('preserves exact event_id during reconciliation of dropped submission', async () => {
    const accountId = 'student_recon_test';
    const eventId = 'evt-reconcile-same-id-123';

    const pendingRecord: PendingReconciliationRecord = {
      eventId,
      accountId,
      studentId: accountId,
      matricNumber: '2021/1/77777CP',
      terminalId,
      sessionId: 'sess_101',
      submissionPayload: {
        version: 1,
        event_id: eventId,
        credential_id: 'cred_1',
        credential_version: 'v1',
        algorithm: 'ECDSA_P256_SHA256',
        student_id: accountId,
        matric_number: '2021/1/77777CP',
        terminal_id: terminalId,
        session_id: 'sess_101',
        challenge: 'nonce_123',
        timestamp: 1791298800,
        timestamp_source: 'phone_os',
        public_key: 'pub_key',
        signature: 'sig_der',
      },
      createdAtIso: new Date().toISOString(),
    };

    // Save pending state after network/BLE disconnect
    await AttendanceReceiptStorage.savePendingReconciliation(pendingRecord);

    // Retrieve pending transaction on retry
    const retrieved = await AttendanceReceiptStorage.getPendingReconciliation(accountId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.eventId).toBe(eventId); // CRITICAL: exact same eventId!
    expect(retrieved?.submissionPayload.event_id).toBe(eventId);

    // Clean up on successful reconciliation
    await AttendanceReceiptStorage.clearPendingReconciliation(accountId);
    expect(await AttendanceReceiptStorage.getPendingReconciliation(accountId)).toBeNull();
  });

  // ── 7. Connectivity Failures vs Explicit Session Revocation ──────────────────
  test('differentiates network and gateway errors from explicit session revocation', () => {
    // Gateway / network transient failures
    expect(isNetworkError(new Error('Network request failed'))).toBe(true);
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new Error('Connection timed out'))).toBe(true);
    expect(isNetworkError(new Error('AbortError'))).toBe(true);

    // Explicit application-level revocation (should NOT be classified as network error)
    expect(isNetworkError(new Error('Session expired or invalid'))).toBe(false);
    expect(isNetworkError(new Error('User account disabled'))).toBe(false);
    expect(isNetworkError(new Error('Maximum activation attempts exceeded'))).toBe(false);
  });
});
