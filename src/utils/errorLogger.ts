/**
 * errorLogger.ts
 *
 * In-app error capture and surfacing for release builds with no adb access.
 *
 * Strategy:
 * - Stores crashes in a module-level ring buffer (survives React re-renders,
 *   survives ErrorBoundary reset, but not app process restarts — that's fine,
 *   because the ErrorBoundary shows the crash on screen immediately and the
 *   user can copy it before restarting).
 * - Installs global handlers for uncaught JS errors and unhandled promise
 *   rejections, so errors outside the React tree are also captured.
 *
 * No native file I/O is required — everything is in-memory, displayed on
 * screen, and copyable to clipboard via the ErrorBoundary UI.
 */

export interface CrashEntry {
  ts: string;
  type: 'react' | 'uncaught' | 'unhandledRejection';
  message: string;
  stack: string;
}

// ── In-memory ring buffer (max 10 entries) ────────────────────────────────────
const MAX_ENTRIES = 10;
const _crashLog: CrashEntry[] = [];
let _latestCrash: CrashEntry | null = null;

export function getLatestCrash(): CrashEntry | null {
  return _latestCrash;
}

export function getAllCrashes(): CrashEntry[] {
  return [..._crashLog];
}

export function logCrash(entry: CrashEntry): void {
  _latestCrash = entry;
  _crashLog.push(entry);
  if (_crashLog.length > MAX_ENTRIES) {
    _crashLog.shift();
  }
}

export function clearCrashLog(): void {
  _crashLog.length = 0;
  _latestCrash = null;
}

/**
 * Format all captured crashes as a single shareable string.
 */
export function formatCrashLog(): string {
  if (_crashLog.length === 0) return '(no crashes recorded)';
  return _crashLog.map((e, i) =>
    [
      `=== Crash ${i + 1} of ${_crashLog.length} ===`,
      `Time: ${e.ts}`,
      `Type: ${e.type}`,
      `Message: ${e.message}`,
      `Stack:\n${e.stack}`,
    ].join('\n')
  ).join('\n\n---\n\n');
}

/**
 * Install global handlers for uncaught JS errors and unhandled promise
 * rejections. Call this ONCE from index.js BEFORE AppRegistry.registerComponent,
 * so it covers crashes during native module init.
 *
 * @param onError  Optional callback fired each time a crash is recorded.
 *                 Use to show an Alert or update UI state.
 */
export function installGlobalErrorHandlers(
  onError?: (entry: CrashEntry) => void,
): void {
  // ── Uncaught JS errors (ErrorUtils is React Native's global error handler) ──
  const previousHandler = (globalThis as any).ErrorUtils?.getGlobalHandler?.();
  (globalThis as any).ErrorUtils?.setGlobalHandler?.((error: any, isFatal: boolean) => {
    const entry: CrashEntry = {
      ts: new Date().toISOString(),
      type: 'uncaught',
      message: error?.message ?? String(error),
      stack: error?.stack ?? '(no stack)',
    };
    logCrash(entry);
    onError?.(entry);
    if (previousHandler) previousHandler(error, isFatal);
  });

  // ── Unhandled promise rejections ─────────────────────────────────────────────
  const originalUnhandledRejection = (globalThis as any).onunhandledrejection;
  (globalThis as any).onunhandledrejection = (event: any) => {
    const reason = event?.reason;
    const entry: CrashEntry = {
      ts: new Date().toISOString(),
      type: 'unhandledRejection',
      message: reason?.message ?? String(reason),
      stack: reason?.stack ?? '(no stack)',
    };
    logCrash(entry);
    onError?.(entry);
    if (originalUnhandledRejection) originalUnhandledRejection(event);
  };
}
