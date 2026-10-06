import { Buffer } from 'buffer';

export const ATTENDCLASS_SERVICE_UUID = '0000ff10-0000-1000-8000-00805f9b34fb';
export const CHALLENGE_CHAR_UUID = '0000ff11-0000-1000-8000-00805f9b34fb';
export const SUBMISSION_CHAR_UUID = '0000ff12-0000-1000-8000-00805f9b34fb';
export const ACK_CHAR_UUID = '0000ff13-0000-1000-8000-00805f9b34fb';

export const PROTOCOL_VERSION = 1;

export interface TerminalChallengePayload {
  version: number;
  terminal_id: string;
  session_id: string;
  challenge: string; // Base64 unpredictable 32-byte nonce
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
  signature: string; // ECDSA P-256 DER Base64
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
  signature?: string; // Terminal ECDSA P-256 DER Base64
  error_code?: string | null;
}

export interface BleFramePacket {
  txId: string;
  seq: number;
  total: number;
  chunk: string;
}

export class AttendanceProtocol {
  public static readonly MAX_PAYLOAD_BYTES = 4096;
  public static readonly DEFAULT_CHUNK_SIZE = 100; // Fits well within typical negotiated MTU

  /**
   * Build canonical string for student attendance submission.
   * Format: v1|submission|{event_id}|{credential_id}|{credential_version}|{algorithm}|{student_id}|{matric_number}|{terminal_id}|{session_id}|{challenge}|{timestamp}|{timestamp_source}
   */
  public static buildSubmissionCanonicalString(
    params: Omit<AttendanceSubmissionPayload, 'public_key' | 'signature'>,
  ): string {
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
   * Parse and validate terminal challenge packet from raw string or base64.
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

    if (!obj.session_id || typeof obj.session_id !== 'string') {
      throw new Error('MALFORMED_CHALLENGE_PACKET: Missing or invalid session_id');
    }

    if (!obj.challenge || typeof obj.challenge !== 'string' || obj.challenge.length < 16) {
      throw new Error('MALFORMED_CHALLENGE_PACKET: Challenge is missing or too short (replay protection compromised)');
    }

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
   * Split a large string payload into bounded framing packets.
   * Frame header format: ATTF1:<txId>:<seq4>:<total4>:<base64Chunk>
   */
  public static createFrames(rawPayload: string, txId: string, chunkSize = AttendanceProtocol.DEFAULT_CHUNK_SIZE): string[] {
    const rawBytes = Buffer.from(rawPayload, 'utf-8');
    if (rawBytes.length > this.MAX_PAYLOAD_BYTES) {
      throw new Error(`PAYLOAD_EXCEEDS_LIMIT: Max allowed size is ${this.MAX_PAYLOAD_BYTES} bytes`);
    }

    const b64 = rawBytes.toString('base64');
    const totalChunks = Math.ceil(b64.length / chunkSize);
    const frames: string[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const chunk = b64.substring(i * chunkSize, (i + 1) * chunkSize);
      const seqStr = (i + 1).toString().padStart(4, '0');
      const totalStr = totalChunks.toString().padStart(4, '0');
      frames.push(`ATTF1:${txId}:${seqStr}:${totalStr}:${chunk}`);
    }

    return frames;
  }

  /**
   * Parse a single frame packet.
   */
  public static parseFrame(frameStr: string): BleFramePacket {
    const parts = frameStr.split(':');
    if (parts.length < 5 || parts[0] !== 'ATTF1') {
      throw new Error('INVALID_FRAME_HEADER: Expected ATTF1 frame format');
    }

    const txId = parts[1];
    const seq = parseInt(parts[2], 10);
    const total = parseInt(parts[3], 10);
    const chunk = parts.slice(4).join(':'); // Handle any colons in chunk

    if (isNaN(seq) || isNaN(total) || seq < 1 || seq > total) {
      throw new Error(`INVALID_FRAME_SEQUENCE: seq=${seq}, total=${total}`);
    }

    return { txId, seq, total, chunk };
  }
}

/**
 * Reassembles chunked BLE frames with timeout and buffer bounds.
 */
export class FrameReassembler {
  private chunks = new Map<number, string>();
  private totalExpected = 0;
  private txId: string | null = null;
  private createdAt = Date.now();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 15000) {
    this.timeoutMs = timeoutMs;
  }

  public addFrame(frameStr: string): { complete: boolean; payload?: string } {
    if (Date.now() - this.createdAt > this.timeoutMs) {
      throw new Error('FRAME_REASSEMBLY_TIMEOUT: Incomplete packet stream timed out');
    }

    const frame = AttendanceProtocol.parseFrame(frameStr);

    if (this.txId === null) {
      this.txId = frame.txId;
      this.totalExpected = frame.total;
    } else if (this.txId !== frame.txId) {
      throw new Error(`TRANSACTION_MISMATCH: Frame txId=${frame.txId} does not match active txId=${this.txId}`);
    }

    this.chunks.set(frame.seq, frame.chunk);

    if (this.chunks.size === this.totalExpected) {
      let assembledB64 = '';
      for (let i = 1; i <= this.totalExpected; i++) {
        const c = this.chunks.get(i);
        if (!c) throw new Error(`MISSING_FRAME_CHUNK: Missing sequence chunk ${i}`);
        assembledB64 += c;
      }
      const rawPayload = Buffer.from(assembledB64, 'base64').toString('utf-8');
      return { complete: true, payload: rawPayload };
    }

    return { complete: false };
  }
}
