/* eslint-disable no-bitwise */
import { Buffer } from 'buffer';

export const ATTENDCLASS_SERVICE_UUID = '0000ff10-0000-1000-8000-00805f9b34fb';
export const CHALLENGE_CHAR_UUID = '0000ff11-0000-1000-8000-00805f9b34fb';
export const SUBMISSION_CHAR_UUID = '0000ff12-0000-1000-8000-00805f9b34fb';
export const ACK_CHAR_UUID = '0000ff13-0000-1000-8000-00805f9b34fb';

export const PROTOCOL_VERSION = 1;
export const MIN_SUPPORTED_MTU = 23;
export const MIN_ATT_PAYLOAD = 20; // 23 - 3 bytes ATT header
export const FRAME_MAGIC_BYTE = 0xac;
export const FRAME_VERSION_BYTE = 0x01;
export const BINARY_HEADER_SIZE = 6;

export interface TerminalChallengePayload {
  version: number;
  terminal_id: string;
  session_id: string;
  challenge: string; // Base64 unpredictable nonce (>= 16 bytes)
  terminal_time: number;
  time_confidence: 'rtc' | 'unsynchronized' | 'estimated';
  course_code?: string;
  signature?: string; // Terminal ECDSA P-256 signature
}

export interface AttendanceSubmissionPayload {
  version: number;
  event_id: string;
  credential_id: string;
  credential_version: string;
  algorithm: 'ECDSA_P256_SHA256';
  student_id: string;
  matric_number: string;
  terminal_id: string;
  session_id: string;
  challenge: string;
  timestamp: number;
  timestamp_source: 'phone_os' | 'terminal_sync';
  public_key: string; // SPKI DER Base64
  signature: string; // ECDSA P-256 DER or P1363 Base64
}

export interface TerminalAckPayload {
  version: number;
  event_id: string;
  terminal_id: string;
  session_id: string;
  submission_digest: string;
  status: 'DURABLY_SAVED' | 'REJECTED';
  sd_persisted: boolean;
  record_index?: number;
  saved_at?: number;
  signature?: string; // Terminal ECDSA P-256 signature
  error_code?: string | null;
}

export interface BleFramePacket {
  txId: number;
  seq: number;
  total: number;
  chunk: Uint8Array;
}

export class AttendanceProtocol {
  public static readonly MAX_PAYLOAD_BYTES = 2048;

  /**
   * Validate that a field value does not contain delimiter characters or invalid control codes.
   */
  public static validateField(fieldName: string, value: string, maxLen = 256): void {
    if (typeof value !== 'string') {
      throw new Error(`INVALID_FIELD_TYPE: Field ${fieldName} must be a string`);
    }
    if (value.length > maxLen) {
      throw new Error(`FIELD_TOO_LONG: Field ${fieldName} exceeds maximum length of ${maxLen}`);
    }
    if (value.includes('|') || value.includes('\n') || value.includes('\r')) {
      throw new Error(`INVALID_FIELD_DELIMITER: Field ${fieldName} cannot contain pipe '|' or newline characters`);
    }
  }

  /**
   * Build canonical string for student attendance submission.
   * Format: v1|submission|{event_id}|{credential_id}|{credential_version}|{algorithm}|{student_id}|{matric_number}|{terminal_id}|{session_id}|{challenge}|{timestamp}|{timestamp_source}
   */
  public static buildSubmissionCanonicalString(
    params: Omit<AttendanceSubmissionPayload, 'public_key' | 'signature'>,
  ): string {
    this.validateField('event_id', params.event_id);
    this.validateField('credential_id', params.credential_id);
    this.validateField('credential_version', params.credential_version);
    this.validateField('algorithm', params.algorithm);
    this.validateField('student_id', params.student_id);
    this.validateField('matric_number', params.matric_number);
    this.validateField('terminal_id', params.terminal_id);
    this.validateField('session_id', params.session_id);
    this.validateField('challenge', params.challenge);
    this.validateField('timestamp_source', params.timestamp_source);

    return [
      'v1',
      'submission',
      params.event_id,
      params.credential_id,
      params.credential_version,
      params.algorithm,
      params.student_id,
      params.matric_number,
      params.terminal_id,
      params.session_id,
      params.challenge,
      params.timestamp.toString(),
      params.timestamp_source,
    ].join('|');
  }

  /**
   * Parse and validate terminal challenge packet from raw string, JSON, or Base64.
   */
  public static parseChallenge(raw: string): TerminalChallengePayload {
    let json: unknown;
    try {
      const decoded = raw.trim().startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf-8');
      json = JSON.parse(decoded);
    } catch {
      throw new Error('MALFORMED_CHALLENGE_PACKET: Unable to parse JSON challenge from terminal');
    }

    if (!json || typeof json !== 'object') {
      throw new Error('MALFORMED_CHALLENGE_PACKET: Expected JSON object');
    }

    const obj = json as Record<string, unknown>;

    if (obj.version !== PROTOCOL_VERSION) {
      throw new Error(
        `UNSUPPORTED_PROTOCOL_VERSION: Terminal reported v${obj.version}, app requires v${PROTOCOL_VERSION}`,
      );
    }

    if (!obj.terminal_id || typeof obj.terminal_id !== 'string') {
      throw new Error('MALFORMED_CHALLENGE_PACKET: Missing or invalid terminal_id');
    }
    this.validateField('terminal_id', obj.terminal_id);

    if (!obj.session_id || typeof obj.session_id !== 'string') {
      throw new Error('MALFORMED_CHALLENGE_PACKET: Missing or invalid session_id');
    }
    this.validateField('session_id', obj.session_id);

    if (!obj.challenge || typeof obj.challenge !== 'string' || obj.challenge.length < 16) {
      throw new Error('MALFORMED_CHALLENGE_PACKET: Challenge is missing or too short (replay protection compromised)');
    }
    this.validateField('challenge', obj.challenge);

    const timeConfidence =
      obj.time_confidence === 'rtc' || obj.time_confidence === 'estimated'
        ? (obj.time_confidence as 'rtc' | 'estimated')
        : 'unsynchronized';

    return {
      version: obj.version,
      terminal_id: obj.terminal_id,
      session_id: obj.session_id,
      challenge: obj.challenge,
      terminal_time: typeof obj.terminal_time === 'number' ? obj.terminal_time : Math.floor(Date.now() / 1000),
      time_confidence: timeConfidence,
      course_code: typeof obj.course_code === 'string' ? obj.course_code : undefined,
      signature: typeof obj.signature === 'string' ? obj.signature : undefined,
    };
  }

  /**
   * Serialize attendance submission payload to base64 string for BLE characteristic write.
   */
  public static serializeSubmission(payload: AttendanceSubmissionPayload): string {
    const jsonStr = JSON.stringify(payload);
    return Buffer.from(jsonStr, 'utf-8').toString('base64');
  }

  /**
   * Parse and validate terminal durable acknowledgement packet.
   */
  public static parseAck(raw: string, expectedEventId: string): TerminalAckPayload {
    let json: unknown;
    try {
      const decoded = raw.trim().startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf-8');
      json = JSON.parse(decoded);
    } catch {
      throw new Error('MALFORMED_ACK_PACKET: Unable to parse JSON acknowledgement from terminal');
    }

    if (!json || typeof json !== 'object') {
      throw new Error('MALFORMED_ACK_PACKET: Expected JSON object');
    }

    const obj = json as Record<string, unknown>;

    if (obj.version !== PROTOCOL_VERSION) {
      throw new Error(`UNSUPPORTED_PROTOCOL_VERSION: ACK reported v${obj.version}, app requires v${PROTOCOL_VERSION}`);
    }

    if (obj.event_id !== expectedEventId) {
      throw new Error(`EVENT_ID_MISMATCH: Received ACK for event ${obj.event_id}, expected ${expectedEventId}`);
    }

    const status = obj.status as string;
    const sdPersisted = Boolean(obj.sd_persisted);

    if (status !== 'DURABLY_SAVED') {
      const errCode = (obj.error_code as string) || 'UNKNOWN_REJECTION';
      throw new Error(`TERMINAL_REJECTED: ${errCode}`);
    }

    if (!sdPersisted) {
      throw new Error('NO_DURABLE_SAVE: Terminal reported saved but sd_persisted is false');
    }

    return {
      version: obj.version as number,
      event_id: obj.event_id as string,
      terminal_id: (obj.terminal_id as string) || '',
      session_id: (obj.session_id as string) || '',
      submission_digest: (obj.submission_digest as string) || '',
      status: 'DURABLY_SAVED',
      sd_persisted: true,
      record_index: typeof obj.record_index === 'number' ? obj.record_index : undefined,
      saved_at: typeof obj.saved_at === 'number' ? obj.saved_at : undefined,
      signature: typeof obj.signature === 'string' ? obj.signature : undefined,
      error_code: null,
    };
  }

  /**
   * Split a payload into compact binary frames sized to fit within maxFrameSize (raw ATT payload).
   * Frame format:
   * [0xAC, 0x01, txIdHi, txIdLo, seq, total, ...chunkBytes]
   * Header size: 6 bytes.
   * Frame size <= maxFrameSize (guaranteed).
   */
  public static createBinaryFrames(
    payload: string | Uint8Array,
    txIdNum: number,
    maxFrameSize: number,
  ): Uint8Array[] {
    const payloadBytes = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : Buffer.from(payload);

    if (payloadBytes.length > this.MAX_PAYLOAD_BYTES) {
      throw new Error(`PAYLOAD_EXCEEDS_LIMIT: Max allowed size is ${this.MAX_PAYLOAD_BYTES} bytes`);
    }

    if (maxFrameSize < BINARY_HEADER_SIZE + 1) {
      throw new Error(`UNSUPPORTED_MTU: Frame limit ${maxFrameSize} is below minimum requirement (${BINARY_HEADER_SIZE + 1} bytes)`);
    }

    const maxChunkSize = maxFrameSize - BINARY_HEADER_SIZE;
    const totalChunks = Math.ceil(payloadBytes.length / maxChunkSize) || 1;

    if (totalChunks > 255) {
      throw new Error(`PAYLOAD_TOO_LARGE_FOR_FRAMING: Requires ${totalChunks} chunks, max 255 supported`);
    }

    const frames: Uint8Array[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * maxChunkSize;
      const end = Math.min(start + maxChunkSize, payloadBytes.length);
      const chunk = payloadBytes.subarray(start, end);

      const frame = Buffer.alloc(BINARY_HEADER_SIZE + chunk.length);
      frame[0] = FRAME_MAGIC_BYTE;
      frame[1] = FRAME_VERSION_BYTE;
      frame.writeUInt16BE(txIdNum & 0xffff, 2);
      frame[4] = i + 1; // 1-based sequence
      frame[5] = totalChunks;
      frame.set(chunk, BINARY_HEADER_SIZE);

      frames.push(new Uint8Array(frame));
    }

    return frames;
  }

  /**
   * Parse a single compact binary frame packet.
   */
  public static parseBinaryFrame(frameBytes: Uint8Array): BleFramePacket {
    if (frameBytes.length < BINARY_HEADER_SIZE) {
      throw new Error('INVALID_FRAME_HEADER: Binary frame shorter than 6-byte header');
    }

    if (frameBytes[0] !== FRAME_MAGIC_BYTE || frameBytes[1] !== FRAME_VERSION_BYTE) {
      throw new Error('INVALID_FRAME_MAGIC: Header does not match AttendClass v1 magic bytes');
    }

    const buf = Buffer.from(frameBytes);
    const txId = buf.readUInt16BE(2);
    const seq = buf[4];
    const total = buf[5];

    if (seq < 1 || seq > total) {
      throw new Error(`INVALID_FRAME_SEQUENCE: Sequence ${seq} out of bounds for total ${total}`);
    }

    const chunk = frameBytes.subarray(BINARY_HEADER_SIZE);
    return { txId, seq, total, chunk };
  }

  /**
   * Helper to create frames as Base64 strings (for transport) or raw frames.
   */
  public static createFrames(rawPayload: string, txId: string, maxFrameSize = 20): string[] {
    const txIdNum = this.eventIdToTxId(txId);
    const binaryFrames = this.createBinaryFrames(rawPayload, txIdNum, maxFrameSize);
    return binaryFrames.map((f) => Buffer.from(f).toString('base64'));
  }

  /**
   * Convert an eventId string (UUID or hash) into a deterministic 16-bit transaction ID number.
   */
  public static eventIdToTxId(eventId: string): number {
    let hash = 0;
    for (let i = 0; i < eventId.length; i++) {
      hash = ((hash << 5) - hash + eventId.charCodeAt(i)) & 0xffff;
    }
    return hash === 0 ? 1 : hash;
  }
  /**
   * Build canonical string for terminal reconciliation query.
   * Format: v1|reconcile|{eventId}|{studentId}
   */
  public static buildReconciliationCanonicalString(eventId: string, studentId: string): string {
    this.validateField('eventId', eventId);
    this.validateField('studentId', studentId);
    return ['v1', 'reconcile', eventId, studentId].join('|');
  }

  /**
   * Parse reconciliation query string.
   */
  public static parseReconciliationRequest(raw: string): { eventId: string; studentId: string } {
    const parts = raw.trim().split('|');
    if (parts.length < 4 || parts[0] !== 'v1' || parts[1] !== 'reconcile') {
      throw new Error('MALFORMED_RECONCILIATION_REQUEST: Invalid format');
    }
    return { eventId: parts[2], studentId: parts[3] };
  }
}

/**
 * Reassembles chunked BLE binary frames with timeout, duplicate detection, and bounds checking.
 */
export class FrameReassembler {
  private chunks = new Map<number, Uint8Array>();
  private totalExpected = 0;
  private txId: number | null = null;
  private createdAt = Date.now();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 15000) {
    this.timeoutMs = timeoutMs;
  }

  public addFrame(
    frameInput: Uint8Array | string,
  ): { complete: boolean; payload?: string; payloadBytes?: Uint8Array } {
    if (Date.now() - this.createdAt > this.timeoutMs) {
      throw new Error('FRAME_REASSEMBLY_TIMEOUT: Incomplete packet stream timed out');
    }

    let frameBytes: Uint8Array;
    if (typeof frameInput === 'string') {
      // Check if legacy ATTF1 format
      if (frameInput.startsWith('ATTF1:')) {
        const parts = frameInput.split(':');
        if (parts.length < 5) throw new Error('INVALID_FRAME_HEADER: Expected ATTF1 frame format');
        const txId = AttendanceProtocol.eventIdToTxId(parts[1]);
        const seq = parseInt(parts[2], 10);
        const total = parseInt(parts[3], 10);
        const chunk = new Uint8Array(Buffer.from(parts.slice(4).join(':'), 'base64'));
        return this.processChunk(txId, seq, total, chunk);
      }

      // Try decoding base64
      try {
        const decoded = Buffer.from(frameInput, 'base64');
        if (decoded.length >= BINARY_HEADER_SIZE && decoded[0] === FRAME_MAGIC_BYTE && decoded[1] === FRAME_VERSION_BYTE) {
          frameBytes = new Uint8Array(decoded);
        } else {
          frameBytes = new Uint8Array(Buffer.from(frameInput, 'utf-8'));
        }
      } catch {
        frameBytes = new Uint8Array(Buffer.from(frameInput, 'utf-8'));
      }
    } else {
      frameBytes = frameInput;
    }

    // Check if packet is a binary frame
    if (
      frameBytes.length >= BINARY_HEADER_SIZE &&
      frameBytes[0] === FRAME_MAGIC_BYTE &&
      frameBytes[1] === FRAME_VERSION_BYTE
    ) {
      const frame = AttendanceProtocol.parseBinaryFrame(frameBytes);
      return this.processChunk(frame.txId, frame.seq, frame.total, frame.chunk);
    }

    // Unfragmented payload
    const fullBuffer = Buffer.from(frameBytes);
    return {
      complete: true,
      payload: fullBuffer.toString('utf-8'),
      payloadBytes: frameBytes,
    };
  }

  private processChunk(
    txId: number,
    seq: number,
    total: number,
    chunk: Uint8Array,
  ): { complete: boolean; payload?: string; payloadBytes?: Uint8Array } {
    if (total < 1 || total > 255) {
      throw new Error(`INVALID_FRAME_SEQUENCE: Total chunks ${total} must be between 1 and 255`);
    }

    if (seq < 1 || seq > total) {
      throw new Error(`INVALID_FRAME_SEQUENCE: Sequence ${seq} out of bounds for total ${total}`);
    }

    if (this.txId === null) {
      this.txId = txId;
      this.totalExpected = total;
    } else if (this.txId !== txId) {
      throw new Error(`TRANSACTION_MISMATCH: Frame txId=${txId} does not match active txId=${this.txId}`);
    }

    // Check duplicate chunk
    const existing = this.chunks.get(seq);
    if (existing) {
      if (existing.length !== chunk.length) {
        throw new Error(`CONFLICTING_DUPLICATE_FRAGMENT: Received mismatched chunk length for sequence ${seq}`);
      }
      for (let b = 0; b < existing.length; b++) {
        if (existing[b] !== chunk[b]) {
          throw new Error(`CONFLICTING_DUPLICATE_FRAGMENT: Received conflicting bytes for sequence ${seq}`);
        }
      }
      return { complete: false };
    }

    // Bound memory consumption
    let currentBytes = 0;
    for (const c of this.chunks.values()) {
      currentBytes += c.length;
    }
    if (currentBytes + chunk.length > AttendanceProtocol.MAX_PAYLOAD_BYTES) {
      throw new Error(
        `PAYLOAD_EXCEEDS_LIMIT: Reassembly buffer exceeded maximum message size of ${AttendanceProtocol.MAX_PAYLOAD_BYTES} bytes`,
      );
    }

    this.chunks.set(seq, chunk);

    if (this.chunks.size === this.totalExpected) {
      const chunkList: Uint8Array[] = [];
      for (let i = 1; i <= this.totalExpected; i++) {
        const c = this.chunks.get(i);
        if (!c) throw new Error(`MISSING_FRAME_CHUNK: Missing sequence chunk ${i}`);
        chunkList.push(c);
      }

      const fullBuffer = Buffer.concat(chunkList.map((c) => Buffer.from(c)));
      return {
        complete: true,
        payload: fullBuffer.toString('utf-8'),
        payloadBytes: new Uint8Array(fullBuffer),
      };
    }

    return { complete: false };
  }
}
