import { AttendanceProtocol } from '../src/services/AttendanceProtocol';
import { Buffer } from 'buffer';

describe('BLE Protocol & Transaction Validation', () => {
  const validChallenge = JSON.stringify({
    version: 1,
    terminal_id: 'TERM_AEIRG_01',
    session_id: 'sess_20261006_01',
    challenge: 'dGVzdF9jaGFsbGVuZ2VfMzJieXRlc19yYW5kb21fdmFsdWU=',
    terminal_time: 1791298800,
    course_code: 'CPT501',
  });

  test('parses valid terminal challenge successfully', () => {
    const parsed = AttendanceProtocol.parseChallenge(validChallenge);
    expect(parsed.version).toBe(1);
    expect(parsed.terminal_id).toBe('TERM_AEIRG_01');
    expect(parsed.session_id).toBe('sess_20261006_01');
    expect(parsed.challenge).toBe('dGVzdF9jaGFsbGVuZ2VfMzJieXRlc19yYW5kb21fdmFsdWU=');
    expect(parsed.course_code).toBe('CPT501');
  });

  test('rejects challenge with unsupported protocol version', () => {
    const invalidVer = JSON.stringify({
      version: 99,
      terminal_id: 'TERM_01',
      session_id: 'sess_1',
      challenge: 'dGVzdF9jaGFsbGVuZ2VfMzJieXRlc19yYW5kb21fdmFsdWU=',
    });
    expect(() => AttendanceProtocol.parseChallenge(invalidVer)).toThrow('UNSUPPORTED_PROTOCOL_VERSION');
  });

  test('rejects malformed challenge missing required fields', () => {
    const missingFields = JSON.stringify({
      version: 1,
      // missing terminal_id
      session_id: 'sess_1',
      challenge: 'dGVzdF9jaGFsbGVuZ2VfMzJieXRlc19yYW5kb21fdmFsdWU=',
    });
    expect(() => AttendanceProtocol.parseChallenge(missingFields)).toThrow('MALFORMED_CHALLENGE_PACKET');
  });

  test('rejects challenge that is too short (replay risk)', () => {
    const shortChallenge = JSON.stringify({
      version: 1,
      terminal_id: 'TERM_01',
      session_id: 'sess_1',
      challenge: 'abc', // too short
    });
    expect(() => AttendanceProtocol.parseChallenge(shortChallenge)).toThrow('replay protection compromised');
  });

  test('serializes submission packet correctly', () => {
    const submission = {
      version: 1,
      event_id: 'evt-100',
      student_id: 'std-200',
      matric_number: '2021/1/12345CP',
      terminal_id: 'TERM_01',
      session_id: 'sess_1',
      challenge: 'challenge_b64',
      timestamp: 1791298801,
      timestamp_source: 'phone_os' as const,
      public_key: 'pubkey_b64',
      signature: 'sig_b64',
    };

    const b64 = AttendanceProtocol.serializeSubmission(submission);
    expect(typeof b64).toBe('string');
    const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    expect(decoded.event_id).toBe('evt-100');
    expect(decoded.matric_number).toBe('2021/1/12345CP');
  });
});
