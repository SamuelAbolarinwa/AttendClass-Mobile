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
  challenge: string; // Base64 unpredictable 32-byte challenge
  terminal_time: number;
  course_code?: string;
}

export interface AttendanceSubmissionPayload {
  version: number;
  event_id: string;
  student_id: string;
  matric_number: string;
  terminal_id: string;
  session_id: string;
  challenge: string;
  timestamp: number;
  timestamp_source: 'phone_os' | 'terminal_sync';
  public_key: string;
  signature: string;
}

export interface TerminalAckPayload {
  version: number;
  event_id: string;
  status: 'DURABLY_SAVED' | 'REJECTED';
  sd_persisted: boolean;
  record_index?: number;
  saved_at?: number;
  error_code?: string | null;
}

export class AttendanceProtocol {
  /**
   * Parse and validate terminal challenge packet from raw string or base64.
   */
  public static parseChallenge(raw: string): TerminalChallengePayload {
    let json: unknown;
    try {
      // Decode if base64 or parse directly if JSON
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
      throw new Error(`UNSUPPORTED_PROTOCOL_VERSION: Terminal reported v${obj.version}, app requires v${PROTOCOL_VERSION}`);
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

    return {
      version: obj.version,
      terminal_id: obj.terminal_id,
      session_id: obj.session_id,
      challenge: obj.challenge,
      terminal_time: typeof obj.terminal_time === 'number' ? obj.terminal_time : Math.floor(Date.now() / 1000),
      course_code: typeof obj.course_code === 'string' ? obj.course_code : undefined,
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
      status: 'DURABLY_SAVED',
      sd_persisted: true,
      record_index: typeof obj.record_index === 'number' ? obj.record_index : undefined,
      saved_at: typeof obj.saved_at === 'number' ? obj.saved_at : undefined,
      error_code: null,
    };
  }
}
