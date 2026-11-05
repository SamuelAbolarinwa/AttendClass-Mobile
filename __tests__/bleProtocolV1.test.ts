import { p256 } from '@noble/curves/nist.js';
import { Buffer } from 'buffer';
import {
  BleProtocol,
  BleHelloMessage,
  BleChallengeMessage,
  BleProofMessage,
  BleResultMessage,
  BleGetResultMessage,
} from '../src/ble/BleProtocol';
import { BleFraming, FrameReassembler } from '../src/ble/BleFraming';
import { DeviceSecurityService, encodeDERSignature } from '../src/services/DeviceSecurityService';

function generateTestP256KeyPair() {
  const priv = p256.utils.randomSecretKey();
  const uncompressed = p256.getPublicKey(priv, false);
  const spkiPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  const fullSpki = Buffer.concat([spkiPrefix, Buffer.from(uncompressed)]);
  const pubBase64 = fullSpki.toString('base64');
  return { priv, pubBase64 };
}

function signMessageDer(message: string, privKey: Uint8Array): string {
  const msgBytes = Buffer.from(message, 'utf-8');
  const compact = p256.sign(msgBytes, privKey);
  const sigObj = p256.Signature.fromBytes(compact);
  const der = encodeDERSignature(sigObj.r, sigObj.s);
  return Buffer.from(der).toString('base64');
}

describe('AttendClass BLE Protocol v1 Specification', () => {
  const terminalId = 'ESP32-LT101';
  const studentId = 'std-uuid-101';
  const credentialId = 'cred-p256-test';
  let terminalKp: { priv: Uint8Array; pubBase64: string };
  let studentKp: { priv: Uint8Array; pubBase64: string };

  beforeEach(() => {
    terminalKp = generateTestP256KeyPair();
    studentKp = generateTestP256KeyPair();
  });

  test('Step A: HELLO message serializes and parses correctly', () => {
    const nonce = BleProtocol.generateClientNonce();
    expect(nonce.length).toBe(32); // 16 bytes = 32 hex chars

    const reqId = BleProtocol.generateRequestId();
    expect(reqId).toMatch(/^tx-[a-z0-9]+-[a-z0-9]+$/);

    const hello: BleHelloMessage = {
      v: 1,
      type: 'HELLO',
      request_id: reqId,
      device_id: terminalId,
      credential_id: credentialId,
      client_nonce: nonce,
    };

    const serialized = BleProtocol.serializeMessage(hello);
    const parsed = BleProtocol.parseMessage(serialized);
    expect(parsed).toEqual(hello);
  });

  test('Step B: CHALLENGE message validates canonical string and ESP32 signature', () => {
    const reqId = 'tx-test-001';
    const clientNonce = 'a'.repeat(32);
    const challengeNonce = 'b'.repeat(64);

    const challengePayloadWithoutSig: Omit<BleChallengeMessage, 'esp_signature'> = {
      v: 1,
      type: 'CHALLENGE',
      request_id: reqId,
      device_id: terminalId,
      credential_id: credentialId,
      session_id: 'session-0052',
      course_id: 'MCE501',
      client_nonce: clientNonce,
      challenge: challengeNonce,
      valid_for_ms: 30000,
      esp_key_id: 'esp-lt101-v1',
    };

    const canonicalString = BleProtocol.buildChallengeCanonicalString({
      ...challengePayloadWithoutSig,
      esp_signature: '',
    });

    const espSignature = signMessageDer(canonicalString, terminalKp.priv);

    const fullChallenge: BleChallengeMessage = {
      ...challengePayloadWithoutSig,
      esp_signature: espSignature,
    };

    // Verify signature against terminal public key
    const isValid = DeviceSecurityService.verifySignature(
      canonicalString,
      espSignature,
      terminalKp.pubBase64,
    );
    expect(isValid).toBe(true);

    // Tampered course ID fails verification
    const tamperedCanonical = BleProtocol.buildChallengeCanonicalString({
      ...fullChallenge,
      course_id: 'CSC999',
    });
    const isTamperedValid = DeviceSecurityService.verifySignature(
      tamperedCanonical,
      espSignature,
      terminalKp.pubBase64,
    );
    expect(isTamperedValid).toBe(false);
  });

  test('Step C & D: PROOF message signs canonical checkin and validates against student public key', () => {
    const reqId = 'tx-test-001';
    const clientNonce = 'a'.repeat(32);
    const challengeNonce = 'b'.repeat(64);

    const proofCanonicalString = BleProtocol.buildProofCanonicalString({
      deviceId: terminalId,
      credentialId,
      requestId: reqId,
      sessionId: 'session-0052',
      courseId: 'MCE501',
      clientNonce,
      challenge: challengeNonce,
    });

    expect(proofCanonicalString).toContain('ATTENDCLASS_CHECKIN_V1');
    expect(proofCanonicalString).toContain(terminalId);
    expect(proofCanonicalString).toContain('MCE501');

    const studentSignature = signMessageDer(proofCanonicalString, studentKp.priv);

    const proofMsg: BleProofMessage = {
      v: 1,
      type: 'PROOF',
      request_id: reqId,
      credential_id: credentialId,
      algorithm: 'ES256',
      signature_der: studentSignature,
    };

    const isStudentSigValid = DeviceSecurityService.verifySignature(
      proofCanonicalString,
      proofMsg.signature_der,
      studentKp.pubBase64,
    );
    expect(isStudentSigValid).toBe(true);
  });

  test('Step E: RESULT message serializes and verifies receipt signature', () => {
    const resultMsgWithoutSig: Omit<BleResultMessage, 'receipt_signature'> = {
      v: 1,
      type: 'RESULT',
      request_id: 'tx-test-001',
      status: 'SUCCESS',
      student_id: studentId,
      session_id: 'session-0052',
      event_id: 'evt-001-uuid',
      logged_at: '2026-11-04T19:17:32Z',
    };

    const canonicalReceipt = BleProtocol.buildReceiptCanonicalString({
      ...resultMsgWithoutSig,
      receipt_signature: '',
    });

    const receiptSig = signMessageDer(canonicalReceipt, terminalKp.priv);

    const fullResult: BleResultMessage = {
      ...resultMsgWithoutSig,
      receipt_signature: receiptSig,
    };

    const isReceiptValid = DeviceSecurityService.verifySignature(
      canonicalReceipt,
      fullResult.receipt_signature,
      terminalKp.pubBase64,
    );
    expect(isReceiptValid).toBe(true);
  });

  test('Step G: GET_RESULT message for connection recovery', () => {
    const getResult: BleGetResultMessage = {
      v: 1,
      type: 'GET_RESULT',
      request_id: 'tx-test-001',
      credential_id: credentialId,
    };

    const parsed = BleProtocol.parseMessage(BleProtocol.serializeMessage(getResult));
    expect(parsed).toEqual(getResult);
  });

  describe('BLE MTU-23 Binary Framing and Reassembly', () => {
    test('frames large message into chunks and reassembles correctly', () => {
      const largeMessage = JSON.stringify({
        v: 1,
        type: 'CHALLENGE',
        request_id: 'tx-very-long-request-id-1234567890',
        device_id: 'ESP32-LT101-LABORATORY-ROOM-402',
        credential_id: 'cred-p256-very-long-unique-credential-id-987654321',
        session_id: 'session-2026-semester-alpha-0052',
        course_id: 'MCE501-ADVANCED-ROBOTICS',
        client_nonce: '0123456789abcdef0123456789abcdef',
        challenge: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        valid_for_ms: 30000,
        esp_key_id: 'esp-key-institutional-root-p256-v1',
        esp_signature: 'MEQCIGytQ2CkHxnnHniU5FTEt1IZ/1YgmrHzG7tFyMs7Jit3AiBrYvr228g50rogqwSbw5vJvZ9TMwd6Jp/0rdSZIhcvoQ==',
      });

      // Split with MTU 23 chunk size (usable payload = 14 bytes)
      const frames = BleFraming.framePayload(largeMessage, 0x4321, 14);
      expect(frames.length).toBeGreaterThan(10);

      const reassembler = new FrameReassembler(10000);
      let reassembled: string | null = null;

      for (let i = 0; i < frames.length; i++) {
        const res = reassembler.processChunk(frames[i]);
        if (i === frames.length - 1) {
          reassembled = res;
        } else {
          expect(res).toBeNull();
        }
      }

      expect(reassembled).toBe(largeMessage);
    });

    test('rejects frame with invalid magic byte', () => {
      const corruptFrame = new Uint8Array([0x99, 0x01, 0x12, 0x34, 0x01, 0x01, 0x48, 0x69]);
      expect(() => BleFraming.parseFrame(corruptFrame)).toThrow('INVALID_MAGIC_BYTE');
    });

    test('rejects frame with unsupported version', () => {
      const corruptFrame = new Uint8Array([0xac, 0x05, 0x12, 0x34, 0x01, 0x01, 0x48, 0x69]);
      expect(() => BleFraming.parseFrame(corruptFrame)).toThrow('UNSUPPORTED_FRAME_VERSION');
    });
  });
});

