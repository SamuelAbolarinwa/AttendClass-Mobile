export interface DiagnosticLogEntry {
  id: string;
  timestamp: string;
  transactionId?: string;
  stage: string;
  durationMs?: number;
  level: 'info' | 'warn' | 'error';
  errorCode?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const REDACTED_KEYS = new Set([
  'token',
  'password',
  'private_key',
  'privateKey',
  'seed',
  'activation_code',
  'activationCode',
  'p_activation_code',
  'embedding',
  'p_embedding',
  'secret',
]);

export function redactSensitiveData(data: unknown): unknown {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(key) || key.toLowerCase().includes('password') || key.toLowerCase().includes('token') || key.toLowerCase().includes('private')) {
      result[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      result[key] = redactSensitiveData(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

class DiagnosticLoggerService {
  private logs: DiagnosticLogEntry[] = [];
  private readonly maxLogs: number = 200;
  private transactionStartTimes = new Map<string, number>();

  public createTransactionId(prefix = 'tx'): string {
    const rand = Math.random().toString(36).substring(2, 8);
    const ts = Date.now().toString(36);
    return `${prefix}_${ts}_${rand}`;
  }

  public startTransaction(stage = 'INITIALIZE', prefix = 'tx'): string {
    const txId = this.createTransactionId(prefix);
    this.transactionStartTimes.set(txId, Date.now());
    this.info(stage, 'Transaction started', { transactionId: txId });
    return txId;
  }

  public logStage(
    txId: string,
    stage: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const start = this.transactionStartTimes.get(txId);
    const durationMs = start ? Date.now() - start : undefined;
    this.addEntry({
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      transactionId: txId,
      stage,
      durationMs,
      level: 'info',
      message,
      metadata: metadata ? (redactSensitiveData(metadata) as Record<string, unknown>) : undefined,
    });
  }

  public logError(
    txId: string | undefined,
    stage: string,
    errorCode: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const start = txId ? this.transactionStartTimes.get(txId) : undefined;
    const durationMs = start ? Date.now() - start : undefined;
    this.addEntry({
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      transactionId: txId,
      stage,
      durationMs,
      level: 'error',
      errorCode,
      message,
      metadata: metadata ? (redactSensitiveData(metadata) as Record<string, unknown>) : undefined,
    });
  }

  public info(stage: string, message: string, metadata?: Record<string, unknown>): void {
    this.addEntry({
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      stage,
      level: 'info',
      message,
      metadata: metadata ? (redactSensitiveData(metadata) as Record<string, unknown>) : undefined,
    });
  }

  public warn(stage: string, message: string, metadata?: Record<string, unknown>): void {
    this.addEntry({
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      stage,
      level: 'warn',
      message,
      metadata: metadata ? (redactSensitiveData(metadata) as Record<string, unknown>) : undefined,
    });
  }

  public endTransaction(txId: string, success: boolean, summary?: string): void {
    const start = this.transactionStartTimes.get(txId);
    const durationMs = start ? Date.now() - start : undefined;
    this.transactionStartTimes.delete(txId);
    this.addEntry({
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      transactionId: txId,
      stage: 'COMPLETE',
      durationMs,
      level: success ? 'info' : 'warn',
      message: summary || (success ? 'Transaction succeeded' : 'Transaction finished with failure'),
    });
  }

  private addEntry(entry: DiagnosticLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  public getRecentLogs(): DiagnosticLogEntry[] {
    return [...this.logs];
  }

  public clearLogs(): void {
    this.logs = [];
    this.transactionStartTimes.clear();
  }
}

export const DiagnosticLogger = new DiagnosticLoggerService();
