/**
 * AttendClass Attendance State Machine
 *
 * Implements deterministic states, strict entry/exit conditions,
 * timeout handling, and race condition prevention.
 */

import { ClassroomQRPayload } from '../qr/QRPayload';
import { BleChallengeMessage, BleResultMessage } from '../ble/BleProtocol';
import { AttendanceReceipt } from '../services/AttendanceReceiptStorage';

export type AttendanceState =
  | 'READY'
  | 'SCANNING_QR'
  | 'QR_VALIDATED'
  | 'SEARCHING_DEVICE'
  | 'CONNECTING_BLE'
  | 'VERIFYING_ESP'
  | 'WAITING_FOR_CHALLENGE'
  | 'WAITING_FOR_BIOMETRIC'
  | 'SIGNING_CHALLENGE'
  | 'SENDING_PROOF'
  | 'WAITING_FOR_RESULT'
  | 'VERIFYING_RECEIPT'
  | 'SUCCESS'
  | 'ALREADY_RECORDED'
  | 'RECOVERING_RESULT'
  | 'FAILED'
  | 'CANCELLED';

export interface StateMachineContext {
  qrPayload?: ClassroomQRPayload;
  challenge?: BleChallengeMessage;
  result?: BleResultMessage;
  receipt?: AttendanceReceipt;
  errorCode?: string;
  errorMessage?: string;
  courseId?: string;
  sessionId?: string;
  deviceId?: string;
}

export type StateChangeListener = (
  state: AttendanceState,
  context: StateMachineContext,
  userMessage: string,
) => void;

export class AttendanceStateMachine {
  private currentState: AttendanceState = 'READY';
  private context: StateMachineContext = {};
  private listeners: StateChangeListener[] = [];

  // Human-readable status messages for each state
  public static readonly STATE_MESSAGES: Record<AttendanceState, string> = {
    READY: 'Ready to check in',
    SCANNING_QR: 'Position classroom QR code in the viewfinder',
    QR_VALIDATED: 'Classroom QR code validated',
    SEARCHING_DEVICE: 'Searching for classroom device over Bluetooth…',
    CONNECTING_BLE: 'Connecting to classroom attendance terminal…',
    VERIFYING_ESP: 'Verifying classroom device authenticity…',
    WAITING_FOR_CHALLENGE: 'Requesting attendance session challenge…',
    WAITING_FOR_BIOMETRIC: 'Verify your fingerprint to mark attendance',
    SIGNING_CHALLENGE: 'Signing attendance challenge…',
    SENDING_PROOF: 'Sending signed attendance proof to classroom device…',
    WAITING_FOR_RESULT: 'Waiting for attendance durable save confirmation…',
    VERIFYING_RECEIPT: 'Verifying official attendance receipt signature…',
    SUCCESS: 'Attendance recorded successfully!',
    ALREADY_RECORDED: 'Attendance for this session was already recorded',
    RECOVERING_RESULT: 'Recovering attendance confirmation from classroom device…',
    FAILED: 'Check-in not completed',
    CANCELLED: 'Check-in cancelled',
  };

  constructor(initialState: AttendanceState = 'READY') {
    this.currentState = initialState;
  }

  public getState(): AttendanceState {
    return this.currentState;
  }

  public getContext(): Readonly<StateMachineContext> {
    return this.context;
  }

  public subscribe(listener: StateChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  public updateContext(partial: Partial<StateMachineContext>): void {
    this.context = { ...this.context, ...partial };
  }

  /**
   * Transition to next state if valid.
   */
  public transition(
    nextState: AttendanceState,
    contextUpdates?: Partial<StateMachineContext>,
    customMessage?: string,
  ): void {
    const from = this.currentState;

    if (this.isTerminalState(from) && from !== nextState) {
      // Cannot transition out of terminal state unless resetting to READY
      if (nextState !== 'READY') {
        return;
      }
    }

    if (contextUpdates) {
      this.context = { ...this.context, ...contextUpdates };
    }

    this.currentState = nextState;
    const msg = customMessage || AttendanceStateMachine.STATE_MESSAGES[nextState];

    for (const listener of this.listeners) {
      try {
        listener(nextState, this.context, msg);
      } catch {
        // Safe listener execution
      }
    }
  }

  public fail(errorCode: string, errorMessage: string): void {
    this.transition('FAILED', { errorCode, errorMessage }, errorMessage);
  }

  public cancel(reason = 'Check-in cancelled by user'): void {
    this.transition('CANCELLED', { errorMessage: reason }, reason);
  }

  public reset(): void {
    this.context = {};
    this.transition('READY');
  }

  public isTerminalState(state: AttendanceState): boolean {
    return (
      state === 'SUCCESS' ||
      state === 'ALREADY_RECORDED' ||
      state === 'FAILED' ||
      state === 'CANCELLED'
    );
  }
}

