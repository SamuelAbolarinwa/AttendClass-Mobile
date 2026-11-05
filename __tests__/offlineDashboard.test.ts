import * as Keychain from 'react-native-keychain';
import { OfflineDashboardStore, CachedDashboardData } from '../src/services/OfflineDashboardStore';
import { AttendanceReceiptStorage, AttendanceReceipt } from '../src/services/AttendanceReceiptStorage';

describe('Offline Dashboard Storage & Receipt Reconciliation', () => {
  const accountId = 'student-test-101';

  beforeEach(() => {
    (Keychain as any).__resetMockStorage();
  });

  test('saves and loads cached dashboard state from local storage', async () => {
    const data: CachedDashboardData = {
      accountId,
      fullName: 'John Doe',
      matricNumber: '2021/1/99999CP',
      trackingStartDate: '2026-09-01',
      trackingEndDateIso: '2026-12-15T00:00:00.000Z',
      stats: { present: 18, absent: 2, percentage: 90 },
      serverLogs: [
        { id: 'srv-1', verified_at: '2026-10-01T09:00:00Z', method: 'Terminal' },
      ],
      lastSyncedAtIso: '2026-10-01T10:00:00Z',
    };

    await OfflineDashboardStore.saveCachedDashboard(accountId, data);
    const loaded = await OfflineDashboardStore.loadCachedDashboard(accountId);

    expect(loaded).not.toBeNull();
    expect(loaded?.accountId).toBe(accountId);
    expect(loaded?.fullName).toBe('John Doe');
    expect(loaded?.stats.percentage).toBe(90);
  });

  test('merges server-confirmed logs with locally saved offline receipts', async () => {
    const serverLogs = [
      { id: 'srv-1', event_id: 'evt-server-1', verified_at: '2026-10-01T09:00:00Z', method: 'Terminal' },
      { id: 'srv-2', event_id: 'evt-server-2', verified_at: '2026-10-02T09:00:00Z', method: 'Terminal' },
    ];

    const localReceipt: AttendanceReceipt = {
      eventId: 'evt-local-offline-1',
      accountId,
      studentId: accountId,
      matricNumber: '2021/1/99999CP',
      terminalId: 'ESP32-LT101',
      sessionId: 'sess_101',
      attendanceTimestamp: 1791298800,
      phoneTimeConfidence: 'provisional',
      attendanceTimeIso: '2026-10-03T10:00:00Z',
      localReceiptTimeIso: '2026-10-03T10:00:02Z',
      terminalTimeConfidence: 'rtc',
      terminalReceiptSignature: 'MEQCIGytQ2Ck...',
      submissionDigest: 'digest-abc',
      status: 'TERMINAL_CONFIRMED_SD',
      lagosDate: '2026-10-03',
    };

    await AttendanceReceiptStorage.saveReceipt(localReceipt);

    const { logs, localReceiptsCount, pendingSyncCount } =
      await OfflineDashboardStore.getCombinedAttendanceLogs(accountId, serverLogs);

    expect(localReceiptsCount).toBe(1);
    expect(pendingSyncCount).toBe(1);
    expect(logs.length).toBe(3);

    // Unsynced local receipt is tagged appropriately
    const unsynced = logs.find((l) => l.event_id === 'evt-local-offline-1');
    expect(unsynced).toBeDefined();
    expect(unsynced.syncStatus).toBe('SAVED_LOCALLY_PENDING_SYNC');
    expect(unsynced.method).toBe('BLE Offline Terminal');

    // Server-confirmed log is tagged
    const serverConfirmed = logs.find((l) => l.event_id === 'evt-server-1');
    expect(serverConfirmed).toBeDefined();
    expect(serverConfirmed.syncStatus).toBe('SERVER_CONFIRMED');
  });

  test('prevents duplicates when local receipt has already been synchronised by the server', async () => {
    const commonEventId = 'evt-synced-both';
    const serverLogs = [
      { id: 'srv-1', event_id: commonEventId, verified_at: '2026-10-01T09:00:00Z', method: 'Terminal' },
    ];

    const localReceipt: AttendanceReceipt = {
      eventId: commonEventId,
      accountId,
      studentId: accountId,
      matricNumber: '2021/1/99999CP',
      terminalId: 'ESP32-LT101',
      sessionId: 'sess_101',
      attendanceTimestamp: 1791298800,
      phoneTimeConfidence: 'provisional',
      attendanceTimeIso: '2026-10-01T09:00:00Z',
      localReceiptTimeIso: '2026-10-01T09:00:02Z',
      terminalTimeConfidence: 'rtc',
      terminalReceiptSignature: 'MEQCIGytQ2Ck...',
      submissionDigest: 'digest-abc',
      status: 'TERMINAL_CONFIRMED_SD',
      lagosDate: '2026-10-01',
    };

    await AttendanceReceiptStorage.saveReceipt(localReceipt);

    const { logs, pendingSyncCount } =
      await OfflineDashboardStore.getCombinedAttendanceLogs(accountId, serverLogs);

    // Deduplication should result in exactly 1 log entry
    expect(logs.length).toBe(1);
    expect(pendingSyncCount).toBe(0);
  });
});

