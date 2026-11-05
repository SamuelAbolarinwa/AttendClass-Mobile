/**
 * Administrative BLE Synchronisation Service
 *
 * Enables authorised course representatives and administrators to act as a bridge
 * between offline ESP32 terminals and Supabase cloud backend:
 * ESP32 -> BLE -> Authorised Phone -> Supabase
 */

import { supabase } from '../lib/supabase';
import { BleConnectionManager } from '../ble/BleConnectionManager';
import { DiagnosticLogger } from '../services/DiagnosticLogger';

export interface UnsyncedAttendanceRecord {
  eventId: string;
  studentId: string;
  matricNumber: string;
  terminalId: string;
  sessionId: string;
  courseCode: string;
  timestamp: number;
  terminalReceiptSignature: string;
  submissionDigest: string;
}

export interface TerminalStatus {
  terminalId: string;
  clockTime: number;
  timeConfidence: 'rtc' | 'unsynchronized' | 'estimated';
  unsyncedRecordsCount: number;
  activeSessionId?: string;
  activeCourseCode?: string;
  batteryLevel?: number;
}

export interface SyncBatchResult {
  totalProcessed: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  acknowledgedToTerminal: boolean;
}

export class AdminBleSyncService {
  private bleManager: BleConnectionManager;

  constructor(bleManager?: BleConnectionManager) {
    this.bleManager = bleManager || new BleConnectionManager();
  }

  /**
   * Upload downloaded terminal records to Supabase hardware-sync Edge Function.
   */
  public async uploadRecordsToSupabase(
    adminToken: string,
    terminalId: string,
    records: UnsyncedAttendanceRecord[],
  ): Promise<SyncBatchResult> {
    if (records.length === 0) {
      return {
        totalProcessed: 0,
        acceptedCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        acknowledgedToTerminal: true,
      };
    }

    DiagnosticLogger.info('ADMIN_SYNC', `Uploading ${records.length} records to Supabase`, {
      terminalId,
    });

    try {
      const { data, error } = await supabase.functions.invoke('hardware-sync', {
        body: {
          action: 'sync_attendance_batch',
          admin_token: adminToken,
          terminal_id: terminalId,
          records: records.map((r) => ({
            event_id: r.eventId,
            student_id: r.studentId,
            matric_number: r.matricNumber,
            terminal_id: r.terminalId,
            session_id: r.sessionId,
            course_code: r.courseCode,
            timestamp: r.timestamp,
            terminal_receipt_signature: r.terminalReceiptSignature,
            submission_digest: r.submissionDigest,
          })),
        },
      });

      if (error) {
        throw error;
      }

      const result = data as {
        accepted?: number;
        duplicate?: number;
        rejected?: number;
      };

      return {
        totalProcessed: records.length,
        acceptedCount: result.accepted || 0,
        duplicateCount: result.duplicate || 0,
        rejectedCount: result.rejected || 0,
        acknowledgedToTerminal: true,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      DiagnosticLogger.warn('ADMIN_SYNC', 'Cloud batch sync failed', { error: msg });
      throw new Error(`CLOUD_SYNC_FAILED: ${msg}`);
    }
  }

  /**
   * Fetch updated student key registry from Supabase for terminal provisioning.
   */
  public async fetchStudentKeysForProvisioning(adminToken: string): Promise<string> {
    const { data, error } = await supabase.rpc('platform_get_enrolled_keys_csv', {
      p_admin_token: adminToken,
    });

    if (error) {
      throw error;
    }

    return (data as string) || 'student_id,matric_number,public_key,credential_id\n';
  }
}

