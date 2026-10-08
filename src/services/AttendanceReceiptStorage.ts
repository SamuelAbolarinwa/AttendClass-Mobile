import * as Keychain from 'react-native-keychain';
import { AttendanceSubmissionPayload } from './AttendanceProtocol';
import { DiagnosticLogger } from './DiagnosticLogger';

export type AttendanceReceiptStatus =
  | 'SUBMISSION_OUTCOME_UNKNOWN'
  | 'TERMINAL_CONFIRMED_SD'
  | 'CLOUD_SYNC_PENDING'
  | 'CLOUD_SYNC_CONFIRMED'
  | 'DEVICE_CONFIRMED'
  | 'CLOUD_SYNCHRONIZED';

export interface AttendanceReceipt {
  eventId: string;
  accountId: string;
  studentId: string;
  matricNumber: string;
  terminalId: string;
  sessionId: string;
  attendanceTimestamp: number; // Phone seconds (provisional)
  phoneTimeConfidence: 'provisional';
  attendanceTimeIso: string;
  localReceiptTimeIso: string; // Phone time upon receiving verified SD ACK
  terminalSavedAtIso?: string;
  terminalTimeConfidence?: 'rtc' | 'unsynchronized' | 'estimated';
  sdRecordIndex?: number;
  terminalReceiptSignature?: string;
  submissionDigest?: string;
  status: AttendanceReceiptStatus;
  cloudUploadedAtIso?: string;
  lagosDate: string; // YYYY-MM-DD strictly calculated for Africa/Lagos
}

export interface PendingReconciliationRecord {
  eventId: string;
  accountId: string;
  studentId: string;
  matricNumber: string;
  terminalId: string;
  sessionId: string;
  submissionPayload: AttendanceSubmissionPayload;
  createdAtIso: string;
}

export class AttendanceReceiptStorage {
  private static getReceiptsServiceKey(accountId: string): string {
    return `attendclass_receipts_${accountId}`;
  }

  private static getPendingServiceKey(accountId: string): string {
    return `attendclass_pending_recon_${accountId}`;
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
    const service = this.getReceiptsServiceKey(accountId);
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
    const service = this.getReceiptsServiceKey(receipt.accountId);
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
   * Save a transaction pending reconciliation after post-submission disconnect.
   */
  public static async savePendingReconciliation(pending: PendingReconciliationRecord): Promise<void> {
    const service = this.getPendingServiceKey(pending.accountId);
    try {
      await Keychain.setGenericPassword(pending.accountId, JSON.stringify(pending), {
        service,
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
      DiagnosticLogger.info('RECONCILIATION', 'Saved pending transaction for reconciliation', {
        eventId: pending.eventId,
        terminalId: pending.terminalId,
      });
    } catch (err: unknown) {
      DiagnosticLogger.warn('RECONCILIATION', 'Failed saving pending transaction', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get any pending transaction awaiting reconciliation.
   */
  public static async getPendingReconciliation(accountId: string): Promise<PendingReconciliationRecord | null> {
    const service = this.getPendingServiceKey(accountId);
    try {
      const res = await Keychain.getGenericPassword({ service });
      if (!res || !res.password) return null;
      return JSON.parse(res.password) as PendingReconciliationRecord;
    } catch {
      return null;
    }
  }

  /**
   * Clear pending reconciliation record once resolved.
   */
  public static async clearPendingReconciliation(accountId: string): Promise<void> {
    const service = this.getPendingServiceKey(accountId);
    try {
      await Keychain.resetGenericPassword({ service });
    } catch {
      // ignore
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
    const service = this.getReceiptsServiceKey(accountId);
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
   * Clear all receipts for an account.
   */
  public static async clearReceipts(accountId: string): Promise<void> {
    const service = this.getReceiptsServiceKey(accountId);
    try {
      await Keychain.resetGenericPassword({ service });
    } catch {
      // ignore
    }
  }
}
