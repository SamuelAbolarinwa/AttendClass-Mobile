/* eslint-disable no-bitwise */
import {
  AttendanceProtocol,
  FrameReassembler,
  MIN_SUPPORTED_MTU,
  MIN_ATT_PAYLOAD,
  BINARY_HEADER_SIZE,
  FRAME_MAGIC_BYTE,
  FRAME_VERSION_BYTE,
} from '../src/services/AttendanceProtocol';

describe('BLE MTU Sizing, Binary Framing, and Reassembly Integrity', () => {
  const samplePayload = JSON.stringify({
    version: 1,
    event_id: 'evt-mtu-framing-test-001',
    credential_id: 'cred-p256-hardware-test',
    student_id: 'std-uuid-12345',
    matric_number: '2021/1/99999CP',
    terminal_id: 'TERM_AEIRG_01',
    session_id: 'sess_20261006_01',
    challenge: 'dGVzdF9jaGFsbGVuZ2VfMzJieXRlc19yYW5kb21fdmFsdWU=',
    timestamp: 1791298800,
    timestamp_source: 'phone_os',
    public_key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE77edo9o0tvejrv0kEzHJqePFlVqYYP8fg9lqyJOMe8ONKuImJsIgYXA6VNK0KTMWg/OfiBwipkkdjXnra3aKRg==',
    signature: 'MEQCIGytQ2CkHxnnHniU5FTEt1IZ/1YgmrHzG7tFyMs7Jit3AiBrYvr228g50rogqwSbw5vJvZ9TMwd6Jp/0rdSZIhcvoQ==',
  });

  const txId = AttendanceProtocol.eventIdToTxId('evt-mtu-framing-test-001');

  test('enforces minimum supported MTU limit (23 bytes, 20 bytes ATT payload)', () => {
    expect(MIN_SUPPORTED_MTU).toBe(23);
    expect(MIN_ATT_PAYLOAD).toBe(20);
    expect(BINARY_HEADER_SIZE).toBe(6);

    // Frame limit below minimum required header + 1 byte throws UNSUPPORTED_MTU
    expect(() => AttendanceProtocol.createBinaryFrames(samplePayload, txId, 6)).toThrow(
      'UNSUPPORTED_MTU',
    );
  });

  test('all frames fit within 20 bytes on minimum MTU (23 - 3 = 20)', () => {
    const frames = AttendanceProtocol.createBinaryFrames(samplePayload, txId, MIN_ATT_PAYLOAD);

    expect(frames.length).toBeGreaterThan(10); // Standard submission is ~350 bytes -> ~25 frames of 14B chunks

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      // Wire bytes MUST NOT exceed 20 bytes
      expect(frame.length).toBeLessThanOrEqual(20);
      expect(frame.length).toBeGreaterThan(BINARY_HEADER_SIZE);

      // Verify exact header layout: [0xAC, 0x01, txIdHi, txIdLo, seq, total]
      expect(frame[0]).toBe(FRAME_MAGIC_BYTE);
      expect(frame[1]).toBe(FRAME_VERSION_BYTE);
      const frameTxId = (frame[2] << 8) | frame[3];
      expect(frameTxId).toBe(txId);
      expect(frame[4]).toBe(i + 1); // 1-based seq
      expect(frame[5]).toBe(frames.length); // total chunks
    }

    // Successfully reassembles back into exact payload
    const reassembler = new FrameReassembler(5000);
    let result: { complete: boolean; payload?: string } = { complete: false };

    for (const frame of frames) {
      result = reassembler.addFrame(frame);
    }

    expect(result.complete).toBe(true);
    expect(result.payload).toBe(samplePayload);
  });

  test('frames fit within larger negotiated MTU (e.g. 512 -> 509 max frame size)', () => {
    const maxPayload512 = 512 - 3; // 509 bytes
    const frames = AttendanceProtocol.createBinaryFrames(samplePayload, txId, maxPayload512);

    expect(frames.length).toBeLessThanOrEqual(2);
    for (const frame of frames) {
      expect(frame.length).toBeLessThanOrEqual(509);
    }

    const reassembler = new FrameReassembler(5000);
    let result: { complete: boolean; payload?: string } = { complete: false };
    for (const frame of frames) {
      result = reassembler.addFrame(frame);
    }
    expect(result.complete).toBe(true);
    expect(result.payload).toBe(samplePayload);
  });

  test('handles out-of-order frame delivery correctly', () => {
    const frames = AttendanceProtocol.createBinaryFrames(samplePayload, txId, 40);
    expect(frames.length).toBeGreaterThan(3);

    // Shuffle frames
    const shuffled = [...frames].sort(() => Math.random() - 0.5);

    const reassembler = new FrameReassembler(5000);
    let result: { complete: boolean; payload?: string } = { complete: false };

    for (const frame of shuffled) {
      result = reassembler.addFrame(frame);
    }

    expect(result.complete).toBe(true);
    expect(result.payload).toBe(samplePayload);
  });

  test('handles duplicate frames idempotently', () => {
    const frames = AttendanceProtocol.createBinaryFrames(samplePayload, txId, 40);
    const reassembler = new FrameReassembler(5000);

    // Feed first frame twice
    reassembler.addFrame(frames[0]);
    reassembler.addFrame(frames[0]);

    let result: { complete: boolean; payload?: string } = { complete: false };
    for (let i = 1; i < frames.length; i++) {
      result = reassembler.addFrame(frames[i]);
    }

    expect(result.complete).toBe(true);
    expect(result.payload).toBe(samplePayload);
  });

  test('rejects truncated frames and malformed magic bytes', () => {
    // Truncated header (less than 6 bytes)
    const tooShort = new Uint8Array([0xac, 0x01, 0x00]);
    expect(() => AttendanceProtocol.parseBinaryFrame(tooShort)).toThrow('INVALID_FRAME_HEADER');

    // Invalid magic byte
    const wrongMagic = new Uint8Array([0x99, 0x01, 0x00, 0x01, 0x01, 0x01, 0xaa]);
    expect(() => AttendanceProtocol.parseBinaryFrame(wrongMagic)).toThrow('INVALID_FRAME_MAGIC');

    // Invalid sequence number (seq > total)
    const outOfBoundsSeq = new Uint8Array([0xac, 0x01, 0x00, 0x01, 0x05, 0x02, 0xaa]);
    expect(() => AttendanceProtocol.parseBinaryFrame(outOfBoundsSeq)).toThrow('INVALID_FRAME_SEQUENCE');
  });

  test('enforces reassembly timeout', async () => {
    const reassembler = new FrameReassembler(50); // 50ms timeout
    const frames = AttendanceProtocol.createBinaryFrames(samplePayload, txId, 30);

    reassembler.addFrame(frames[0]);

    // Wait 60ms to trigger timeout
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 60));

    expect(() => reassembler.addFrame(frames[1])).toThrow('FRAME_REASSEMBLY_TIMEOUT');
  });
});
