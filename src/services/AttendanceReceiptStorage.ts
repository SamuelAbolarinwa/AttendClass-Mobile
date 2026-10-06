import * as Keychain from 'react-native-keychain';
import { DiagnosticLogger } from './DiagnosticLogger';

export interface AttendanceReceipt {
  eventId: string;
  accountId: string;
  studentId: string;
  matricNumber: string;
  terminalId: string;
  sessionId: string;
  attendanceTimestamp: number; // seconds
  attendanceTimeIso: string;
  localReceiptTimeIso: string; // phone time upon receiving SD ACK
  terminalSavedAtIso?: string;
  sdRecordIndex?: number;
  status: 'DEVICE_CONFIRMED' | 'CLOUD_SYNCHRONIZED';
  cloudUploadedAtIso?: string;
  lagosDate: string; // YYYY-MM-DD strictly calculated for Africa/Lagos
}

export class AttendanceReceiptStorage {
  private static getServiceKey(accountId: string): string {
    return `attendclass_receipts_${accountId}`;
  }

  /**
   * Format any date or epoch into Africa/Lagos YYYY-MM-DD calendar date.
   */
  public static getLagosDate(input?: number | Date | string): string {
    const d = input ? (typeof input === 'number' ? new Date(input * 1000) : new Date(input)) : new Date();
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Lagos',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return formatter.format(d); // en-CA outputs YYYY-MM-DD
    } catch {
      // Fallback: UTC+1 offset (+60 minutes)
      const utc = d.getTime() + d.getTimezoneOffset() * 60000;
      const lagosTime = new Date(utc + 3600000);
      return lagosTime.toISOString().split('T')[0];
    }
  }

  /**
   * Retrieve all saved attendance receipts for an account.
   */
  public static async getReceipts(accountId: string): Promise<AttendanceReceipt[]> {
    const service = this.getServiceKey(accountId);
    try {
      const res = await Keychain.getGenericPassword({ service });
      if (!res || !res.password) {
        return [];
      }
      return JSON.parse(res.password) as AttendanceReceipt[];
    } catch (err: unknown) {
      DiagnosticLogger.warn('RECEIPTS', 'Failed loading receipts', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Save a new device-confirmed receipt idempotently.
   */
  public static async saveReceipt(receipt: AttendanceReceipt): Promise<void> {
    const service = this.getServiceKey(receipt.accountId);
    try {
      const existing = await this.getReceipts(receipt.accountId);
      // Deduplicate by eventId
      const filtered = existing.filter((r) => r.eventId !== receipt.eventId);
      filtered.unshift(receipt);

      // Keep up to 100 recent receipts
      const trimmed = filtered.slice(0, 100);

      await Keychain.setGenericPassword(receipt.accountId, JSON.stringify(trimmed), {
        service,
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });

      DiagnosticLogger.info('RECEIPTS', 'Receipt saved locally', {
        eventId: receipt.eventId,
        terminalId: receipt.terminalId,
        lagosDate: receipt.lagosDate,
      });
    } catch (err: unknown) {
      DiagnosticLogger.logError(
        receipt.eventId,
        'RECEIPT_SAVE',
        'STORAGE_ERROR',
        `Failed saving receipt: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Mark a receipt as CLOUD_SYNCHRONIZED once Supabase or terminal confirms upload.
   */
  public static async markSynchronized(
    accountId: string,
    eventId: string,
    cloudUploadedAtIso: string,
  ): Promise<void> {
    const service = this.getServiceKey(accountId);
    try {
      const existing = await this.getReceipts(accountId);
      const updated = existing.map((r) => {
        if (r.eventId === eventId) {
          return {
            ...r,
            status: 'CLOUD_SYNCHRONIZED' as const,
            cloudUploadedAtIso,
          };
        }
        return r;
      });

      await Keychain.setGenericPassword(accountId, JSON.stringify(updated), {
        service,
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    } catch (err: unknown) {
      DiagnosticLogger.warn('RECEIPTS', 'Failed marking receipt synchronized', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check if attendance was already logged for today (Africa/Lagos date).
   */
  public static async hasLoggedToday(
    accountId: string,
    todayLagosDate?: string,
  ): Promise<{ logged: boolean; receipt?: AttendanceReceipt }> {
    const targetDate = todayLagosDate || this.getLagosDate();
    const receipts = await this.getReceipts(accountId);
    const match = receipts.find((r) => r.lagosDate === targetDate);
    return {
      logged: !!match,
      receipt: match,
    };
  }

  /**
   * Clear all receipts for an account (e.g. On account deletion or signout if requested).
   */
  public static async clearReceipts(accountId: string): Promise<void> {
    const service = this.getServiceKey(accountId);
    try {
      await Keychain.resetGenericPassword({ service });
    } catch {
      // ignore
    }
  }
}
