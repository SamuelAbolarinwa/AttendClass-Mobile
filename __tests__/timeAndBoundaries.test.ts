import { AttendanceReceiptStorage } from '../src/services/AttendanceReceiptStorage';

describe('Time Provenance & Lagos Calendar Boundaries', () => {
  test('correctly normalizes calendar date to Africa/Lagos (UTC+1)', () => {
    // 2026-10-06 23:30:00 UTC is 2026-10-07 00:30:00 in Lagos (UTC+1)!
    const lateUtcDate = new Date('2026-10-06T23:30:00.000Z');
    const lagosDate = AttendanceReceiptStorage.getLagosDate(lateUtcDate);
    expect(lagosDate).toBe('2026-10-07');

    // 2026-10-06 14:00:00 UTC is 2026-10-06 in Lagos
    const middayUtcDate = new Date('2026-10-06T14:00:00.000Z');
    const lagosMidday = AttendanceReceiptStorage.getLagosDate(middayUtcDate);
    expect(lagosMidday).toBe('2026-10-06');
  });

  test('detects duplicate check-in on the same Lagos calendar date', async () => {
    const studentId = 'student-lagos-test-1';

    // Before logging
    const initialCheck = await AttendanceReceiptStorage.hasLoggedToday(studentId, '2026-10-06');
    expect(initialCheck.logged).toBe(false);

    // Save attendance receipt for today
    await AttendanceReceiptStorage.saveReceipt({
      eventId: 'evt-lagos-1',
      accountId: studentId,
      studentId,
      matricNumber: '2021/1/1111CP',
      terminalId: 'TERM_01',
      sessionId: 'sess_1',
      attendanceTimestamp: 1791298800,
      phoneTimeConfidence: 'provisional',
      attendanceTimeIso: new Date().toISOString(),
      localReceiptTimeIso: new Date().toISOString(),
      status: 'DEVICE_CONFIRMED',
      lagosDate: '2026-10-06',
    });

    // Check again
    const afterCheck = await AttendanceReceiptStorage.hasLoggedToday(studentId, '2026-10-06');
    expect(afterCheck.logged).toBe(true);
    expect(afterCheck.receipt?.eventId).toBe('evt-lagos-1');
  });
});
