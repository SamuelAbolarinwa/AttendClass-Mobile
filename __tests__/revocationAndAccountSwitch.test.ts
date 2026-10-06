import * as Keychain from 'react-native-keychain';
import { AttendanceSigner } from '../src/services/AttendanceSigner';
import { AttendanceReceiptStorage, AttendanceReceipt } from '../src/services/AttendanceReceiptStorage';

describe('Revocation & Account Switching Isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Keychain as any).__resetMockStorage();
  });

  test('device keys and receipts are isolated between different student accounts', async () => {
    const studentA = 'student-id-A';
    const studentB = 'student-id-B';

    // Enroll device key for Student A
    const keyA = await AttendanceSigner.generateAndStoreDeviceKey(studentA);
    expect(keyA.publicKeyDerBase64).toBeDefined();

    // Check device key status
    expect(await AttendanceSigner.hasEnrolledDeviceKey(studentA)).toBe(true);
    expect(await AttendanceSigner.hasEnrolledDeviceKey(studentB)).toBe(false);

    // Save attendance receipt for Student A
    const receiptA: AttendanceReceipt = {
      eventId: 'evt-A-1',
      accountId: studentA,
      studentId: studentA,
      matricNumber: '2021/1/0001CP',
      terminalId: 'TERM_01',
      sessionId: 'sess_1',
      attendanceTimestamp: Math.floor(Date.now() / 1000),
      phoneTimeConfidence: 'provisional',
      attendanceTimeIso: new Date().toISOString(),
      localReceiptTimeIso: new Date().toISOString(),
      status: 'DEVICE_CONFIRMED',
      lagosDate: '2026-10-06',
    };
    await AttendanceReceiptStorage.saveReceipt(receiptA);

    // Student A has 1 receipt, Student B has 0 receipts
    const receiptsA = await AttendanceReceiptStorage.getReceipts(studentA);
    const receiptsB = await AttendanceReceiptStorage.getReceipts(studentB);
    expect(receiptsA.length).toBe(1);
    expect(receiptsB.length).toBe(0);

    // Explicit revocation of Student A's device
    await AttendanceSigner.clearDeviceKey(studentA);
    expect(await AttendanceSigner.hasEnrolledDeviceKey(studentA)).toBe(false);

    // Receipts can be cleared on account logout/change
    await AttendanceReceiptStorage.clearReceipts(studentA);
    expect((await AttendanceReceiptStorage.getReceipts(studentA)).length).toBe(0);
  });
});
