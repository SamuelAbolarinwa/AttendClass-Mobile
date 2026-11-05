import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { TerminalAckPayload } from './AttendanceProtocol';
import { DeviceSecurityService } from './DeviceSecurityService';
import { DiagnosticLogger } from './DiagnosticLogger';

export interface TerminalTrustRecord {
  terminalId: string;
  publicKeyDerBase64: string;
  institution: string;
  validFromIso: string;
  validUntilIso: string;
}

export interface TerminalChallengePayload {
  version: number;
  terminal_id: string;
  session_id: string;
  challenge: string; // Unpredictable 32-byte nonce (Base64)
  terminal_time: number;
  time_confidence: 'rtc' | 'unsynchronized' | 'estimated';
  course_code?: string;
  signature?: string; // Terminal ECDSA P-256 signature
}

export interface TerminalReceiptPayload {
  version: number;
  event_id: string;
  terminal_id: string;
  session_id: string;
  submission_digest: string; // SHA-256 hex digest of canonical submission
  status: 'DURABLY_SAVED' | 'REJECTED';
  sd_persisted: boolean;
  record_index?: number;
  saved_at?: number;
  signature?: string; // Terminal ECDSA P-256 signature over receipt
  error_code?: string | null;
}

export class TerminalTrustStore {
  public static readonly DEFAULT_TERMINALS: TerminalTrustRecord[] = [
    {
      terminalId: 'ESP32-LT101',
      publicKeyDerBase64:
        'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE77edo9o0tvejrv0kEzHJqePFlVqYYP8fg9lqyJOMe8ONKuImJsIgYXA6VNK0KTMWg/OfiBwipkkdjXnra3aKRg==',
      institution: 'AttendClass University',
      validFromIso: '2026-01-01T00:00:00Z',
      validUntilIso: '2030-01-01T00:00:00Z',
    },
    {
      terminalId: 'TERM-LAB1-01',
      publicKeyDerBase64:
        'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE77edo9o0tvejrv0kEzHJqePFlVqYYP8fg9lqyJOMe8ONKuImJsIgYXA6VNK0KTMWg/OfiBwipkkdjXnra3aKRg==',
      institution: 'AttendClass University',
      validFromIso: '2026-01-01T00:00:00Z',
      validUntilIso: '2030-01-01T00:00:00Z',
    },
  ];

  // Static registry of authorized institution terminals
  // In production, synced securely from Supabase device registry or institution root cert
  private static trustedTerminals = new Map<string, TerminalTrustRecord>(
    TerminalTrustStore.DEFAULT_TERMINALS.map((t) => [t.terminalId, t]),
  );

  // In-memory replay buffer for seen challenge nonces: nonce -> timestamp (ms)
  private static seenChallengeNonces = new Map<string, number>();
  private static readonly CHALLENGE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

  public static initDefaults(): void {
    for (const t of this.DEFAULT_TERMINALS) {
      this.trustedTerminals.set(t.terminalId, t);
    }
  }

  public static getAllTrustedTerminals(): TerminalTrustRecord[] {
    return Array.from(this.trustedTerminals.values());
  }

  /**
   * Register or update an authorized terminal key in trust store.
   */
  public static registerTrustedTerminal(record: TerminalTrustRecord): void {
    this.trustedTerminals.set(record.terminalId, record);
    DiagnosticLogger.info('TRUST_STORE', 'Registered trusted terminal', {
      terminalId: record.terminalId,
      institution: record.institution,
    });
  }

  /**
   * Check if terminal is in institution trust store.
   */
  public static isTerminalTrusted(terminalId: string): boolean {
    return this.trustedTerminals.has(terminalId);
  }

  /**
   * Get terminal public key DER Base64 if authorized.
   */
  public static getTerminalPublicKey(terminalId: string): string | null {
    const rec = this.trustedTerminals.get(terminalId);
    return rec ? rec.publicKeyDerBase64 : null;
  }

  /**
   * Build canonical string for terminal challenge.
   * Format: v1|challenge|{terminal_id}|{session_id}|{challenge}|{terminal_time}|{time_confidence}|{course_code}
   */
  public static buildChallengeCanonicalString(payload: TerminalChallengePayload): string {
    return [
      'v1',
      'challenge',
      payload.terminal_id,
      payload.session_id,
      payload.challenge,
      payload.terminal_time.toString(),
      payload.time_confidence || 'unsynchronized',
      payload.course_code || '',
    ].join('|');
  }

  /**
   * Build canonical string for terminal receipt.
   * Format: v1|receipt|{event_id}|{terminal_id}|{session_id}|{submission_digest}|{status}|{sd_persisted}|{record_index}|{saved_at}
   */
  public static buildReceiptCanonicalString(
    receipt: TerminalReceiptPayload,
    submissionDigest: string,
  ): string {
    return [
      'v1',
      'receipt',
      receipt.event_id,
      receipt.terminal_id,
      receipt.session_id,
      submissionDigest,
      receipt.status,
      receipt.sd_persisted ? 'true' : 'false',
      receipt.record_index !== undefined ? receipt.record_index.toString() : '',
      receipt.saved_at !== undefined ? receipt.saved_at.toString() : '',
    ].join('|');
  }

  /**
   * Compute SHA-256 digest hex of canonical student submission.
   */
  public static computeSubmissionDigest(canonicalSubmission: string): string {
    const raw = Buffer.from(canonicalSubmission, 'utf-8');
    const digest = sha256(raw);
    return Buffer.from(digest).toString('hex');
  }

  /**
   * Verify terminal challenge:
   * 1. Terminal must be in institutional trust store.
   * 2. Nonce must not be replayed.
   * 3. Terminal cryptographic signature over challenge canonical string must be valid.
   */
  public static verifyTerminalChallenge(
    challenge: TerminalChallengePayload,
  ): { valid: boolean; reason?: string } {
    // 1. Terminal ID trust check
    const terminalKey = this.getTerminalPublicKey(challenge.terminal_id);
    if (!terminalKey) {
      return {
        valid: false,
        reason: `UNTRUSTED_TERMINAL: Terminal ${challenge.terminal_id} is not authorized by the institution.`,
      };
    }

    // 2. Replay check
    const now = Date.now();
    this.cleanExpiredNonces(now);

    if (this.seenChallengeNonces.has(challenge.challenge)) {
      return {
        valid: false,
        reason: 'REPLAYED_CHALLENGE: Terminal challenge nonce was already used in a recent transaction.',
      };
    }

    // 3. Signature verification
    if (!challenge.signature) {
      return {
        valid: false,
        reason: 'UNSIGNED_CHALLENGE: Terminal did not provide required cryptographic signature.',
      };
    }

    const canonicalMsg = this.buildChallengeCanonicalString(challenge);
    const isSigValid = DeviceSecurityService.verifySignature(
      canonicalMsg,
      challenge.signature,
      terminalKey,
    );

    if (!isSigValid) {
      return {
        valid: false,
        reason: 'FORGED_TERMINAL_CHALLENGE: Terminal signature verification failed.',
      };
    }

    // Record nonce only after signature is cryptographically verified
    this.seenChallengeNonces.set(challenge.challenge, now);

    return { valid: true };
  }

  /**
   * Verify terminal durable receipt:
   * 1. Terminal must be trusted.
   * 2. Status must be DURABLY_SAVED and sd_persisted true.
   * 3. Terminal cryptographic signature over receipt canonical string must be valid.
   */
  public static verifyTerminalReceipt(
    receipt: TerminalAckPayload,
    expectedSubmissionDigest: string,
  ): { valid: boolean; reason?: string } {
    const terminalKey = this.getTerminalPublicKey(receipt.terminal_id);
    if (!terminalKey) {
      return {
        valid: false,
        reason: `UNTRUSTED_TERMINAL: Terminal ${receipt.terminal_id} is not in trust store.`,
      };
    }

    if (receipt.status !== 'DURABLY_SAVED' || !receipt.sd_persisted) {
      return {
        valid: false,
        reason: `TERMINAL_REJECTED: Attendance was rejected or not persisted to SD (status: ${receipt.status}).`,
      };
    }

    if (receipt.submission_digest !== expectedSubmissionDigest) {
      return {
        valid: false,
        reason: 'SUBMISSION_DIGEST_MISMATCH: Terminal acknowledged a different submission digest.',
      };
    }

    if (!receipt.signature) {
      return {
        valid: false,
        reason: 'UNSIGNED_RECEIPT: Terminal receipt lacks required cryptographic signature.',
      };
    }

    const canonicalReceipt = this.buildReceiptCanonicalString(receipt, expectedSubmissionDigest);
    const isSigValid = DeviceSecurityService.verifySignature(
      canonicalReceipt,
      receipt.signature,
      terminalKey,
    );

    if (!isSigValid) {
      return {
        valid: false,
        reason: 'FORGED_TERMINAL_RECEIPT: Terminal receipt signature verification failed.',
      };
    }

    return { valid: true };
  }

  private static cleanExpiredNonces(now: number): void {
    for (const [nonce, timestamp] of this.seenChallengeNonces.entries()) {
      if (now - timestamp > this.CHALLENGE_EXPIRY_MS) {
        this.seenChallengeNonces.delete(nonce);
      }
    }
  }

  /**
   * For testing: Reset trusted terminals and nonces.
   */
  public static __resetTrustStore(): void {
    this.trustedTerminals.clear();
    this.seenChallengeNonces.clear();
  }
}
