import * as Keychain from 'react-native-keychain';
import { AttendanceReceiptStorage, AttendanceReceipt } from './AttendanceReceiptStorage';
import { DiagnosticLogger } from './DiagnosticLogger';

export interface CachedDashboardData {
  accountId: string;
  fullName: string;
  matricNumber?: string;
  trackingStartDate: string;
  trackingEndDateIso: string;
  stats: {
    present: number;
    absent: number;
    percentage: number;
  };
  serverLogs: any[];
  lastSyncedAtIso: string;
}

export class OfflineDashboardStore {
  private static getServiceKey(accountId: string): string {
    return `attendclass_dash_cache_${accountId}`;
  }

  /**
   * Save dashboard state for offline display.
   */
  public static async saveCachedDashboard(
    accountId: string,
    data: CachedDashboardData,
  ): Promise<void> {
    try {
      await Keychain.setGenericPassword('dash_cache', JSON.stringify(data), {
        service: this.getServiceKey(accountId),
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
      DiagnosticLogger.info('DASH_CACHE', 'Persisted dashboard state for offline use', {
        accountId,
        lastSyncedAt: data.lastSyncedAtIso,
      });
    } catch (err: unknown) {
      DiagnosticLogger.warn('DASH_CACHE', 'Failed to save dashboard cache', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load locally cached dashboard state.
   */
  public static async loadCachedDashboard(
    accountId: string,
  ): Promise<CachedDashboardData | null> {
    try {
      const res = await Keychain.getGenericPassword({
        service: this.getServiceKey(accountId),
      });
      if (res && res.password) {
        return JSON.parse(res.password) as CachedDashboardData;
      }
    } catch (err: unknown) {
      DiagnosticLogger.warn('DASH_CACHE', 'Failed to load cached dashboard', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  /**
   * Merge server attendance logs with locally verified terminal receipts.
   */
  public static async getCombinedAttendanceLogs(
    accountId: string,
    serverLogs: any[] = [],
  ): Promise<{
    logs: any[];
    localReceiptsCount: number;
    pendingSyncCount: number;
  }> {
    const localReceipts: AttendanceReceipt[] =
      await AttendanceReceiptStorage.getAllReceipts(accountId);

    // Map server logs by date or event ID for deduplication
    const seenEvents = new Set<string>();
    const seenDates = new Set<string>();
    const combined: any[] = [];

    // 1. Process server-confirmed logs
    for (const log of serverLogs) {
      const dateStr = log.verified_at ? log.verified_at.split('T')[0] : '';
      if (log.event_id) seenEvents.add(log.event_id);
      if (dateStr) seenDates.add(dateStr);

      combined.push({
        ...log,
        syncStatus: 'SERVER_CONFIRMED',
        source: 'server',
      });
    }

    let pendingSyncCount = 0;

    // 2. Add local terminal receipts not yet synced to server
    for (const receipt of localReceipts) {
      const isAlreadyOnServer =
        (receipt.eventId && seenEvents.has(receipt.eventId)) ||
        (receipt.lagosDate && seenDates.has(receipt.lagosDate));

      if (!isAlreadyOnServer) {
        pendingSyncCount++;
        combined.unshift({
          id: receipt.eventId,
          event_id: receipt.eventId,
          verified_at: receipt.terminalSavedAtIso || receipt.attendanceTimeIso,
          method: 'BLE Offline Terminal',
          terminal_id: receipt.terminalId,
          syncStatus: 'SAVED_LOCALLY_PENDING_SYNC',
          source: 'local_terminal_receipt',
          receiptSignature: receipt.terminalReceiptSignature,
        });
      }
    }

    return {
      logs: combined,
      localReceiptsCount: localReceipts.length,
      pendingSyncCount,
    };
  }
}

