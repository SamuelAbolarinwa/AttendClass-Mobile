import { AttendanceProtocol } from '../src/services/AttendanceProtocol';

describe('Durable Persistence & Acknowledgement Enforcement', () => {
  const eventId = 'evt-test-durable-999';

  test('accepts valid durable persistence ACK with sd_persisted true', () => {
    const validAck = JSON.stringify({
      version: 1,
      event_id: eventId,
      status: 'DURABLY_SAVED',
      sd_persisted: true,
      record_index: 42,
      saved_at: 1791298805,
      error_code: null,
    });

    const parsed = AttendanceProtocol.parseAck(validAck, eventId);
    expect(parsed.status).toBe('DURABLY_SAVED');
    expect(parsed.sd_persisted).toBe(true);
    expect(parsed.record_index).toBe(42);
  });

  test('strictly rejects acknowledgement if sd_persisted is false', () => {
    const memoryOnlyAck = JSON.stringify({
      version: 1,
      event_id: eventId,
      status: 'DURABLY_SAVED',
      sd_persisted: false, // NOT persisted to SD card!
    });

    expect(() => AttendanceProtocol.parseAck(memoryOnlyAck, eventId)).toThrow('NO_DURABLE_SAVE');
  });

  test('strictly rejects acknowledgement if event_id does not match current transaction', () => {
    const wrongEventAck = JSON.stringify({
      version: 1,
      event_id: 'evt-different-foreign-id',
      status: 'DURABLY_SAVED',
      sd_persisted: true,
    });

    expect(() => AttendanceProtocol.parseAck(wrongEventAck, eventId)).toThrow('EVENT_ID_MISMATCH');
  });

  test('strictly rejects if terminal reported REJECTED with error code', () => {
    const rejectedAck = JSON.stringify({
      version: 1,
      event_id: eventId,
      status: 'REJECTED',
      sd_persisted: false,
      error_code: 'INVALID_SIGNATURE',
    });

    expect(() => AttendanceProtocol.parseAck(rejectedAck, eventId)).toThrow('TERMINAL_REJECTED: INVALID_SIGNATURE');
  });
});
