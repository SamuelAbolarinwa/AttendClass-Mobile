import { AttendanceStateMachine, AttendanceState } from '../src/attendance/AttendanceStateMachine';

describe('Attendance State Machine Transitions', () => {
  let sm: AttendanceStateMachine;

  beforeEach(() => {
    sm = new AttendanceStateMachine();
  });

  test('initializes in READY state with default message', () => {
    expect(sm.getState()).toBe('READY');
    expect(AttendanceStateMachine.STATE_MESSAGES.READY).toBe('Ready to check in');
  });

  test('executes complete linear happy path transitions', () => {
    const statesVisited: AttendanceState[] = [];
    sm.subscribe((state) => {
      statesVisited.push(state);
    });

    sm.transition('SCANNING_QR');
    sm.transition('QR_VALIDATED', { deviceId: 'ESP32-LT101' });
    sm.transition('SEARCHING_DEVICE');
    sm.transition('CONNECTING_BLE');
    sm.transition('WAITING_FOR_CHALLENGE');
    sm.transition('VERIFYING_ESP');
    sm.transition('WAITING_FOR_BIOMETRIC');
    sm.transition('SIGNING_CHALLENGE');
    sm.transition('SENDING_PROOF');
    sm.transition('WAITING_FOR_RESULT');
    sm.transition('VERIFYING_RECEIPT');
    sm.transition('SUCCESS');

    expect(sm.getState()).toBe('SUCCESS');
    expect(sm.isTerminalState(sm.getState())).toBe(true);
    expect(statesVisited).toEqual([
      'SCANNING_QR',
      'QR_VALIDATED',
      'SEARCHING_DEVICE',
      'CONNECTING_BLE',
      'WAITING_FOR_CHALLENGE',
      'VERIFYING_ESP',
      'WAITING_FOR_BIOMETRIC',
      'SIGNING_CHALLENGE',
      'SENDING_PROOF',
      'WAITING_FOR_RESULT',
      'VERIFYING_RECEIPT',
      'SUCCESS',
    ]);
  });

  test('transitions to ALREADY_RECORDED when student has logged previously', () => {
    sm.transition('SCANNING_QR');
    sm.transition('QR_VALIDATED');
    sm.transition('SEARCHING_DEVICE');
    sm.transition('CONNECTING_BLE');
    sm.transition('WAITING_FOR_CHALLENGE');
    sm.transition('VERIFYING_ESP');
    sm.transition('WAITING_FOR_BIOMETRIC');
    sm.transition('SIGNING_CHALLENGE');
    sm.transition('SENDING_PROOF');
    sm.transition('WAITING_FOR_RESULT');
    sm.transition('VERIFYING_RECEIPT');
    sm.transition('ALREADY_RECORDED');

    expect(sm.getState()).toBe('ALREADY_RECORDED');
    expect(sm.isTerminalState('ALREADY_RECORDED')).toBe(true);
  });

  test('transitions to RECOVERING_RESULT on interrupted connection', () => {
    sm.transition('SENDING_PROOF');
    sm.transition('WAITING_FOR_RESULT');
    sm.transition('RECOVERING_RESULT');
    expect(sm.getState()).toBe('RECOVERING_RESULT');

    sm.transition('VERIFYING_RECEIPT');
    sm.transition('SUCCESS');
    expect(sm.getState()).toBe('SUCCESS');
  });

  test('transitions to FAILED on failure and preserves error info', () => {
    sm.transition('SEARCHING_DEVICE');
    sm.fail('BLUETOOTH_TIMEOUT', 'Classroom terminal was not found within 15 seconds.');

    expect(sm.getState()).toBe('FAILED');
    expect(sm.getContext().errorCode).toBe('BLUETOOTH_TIMEOUT');
    expect(sm.getContext().errorMessage).toContain('Classroom terminal was not found');
  });

  test('transitions to CANCELLED on user abort', () => {
    sm.transition('SEARCHING_DEVICE');
    sm.cancel('User backed out');

    expect(sm.getState()).toBe('CANCELLED');
    expect(sm.getContext().errorMessage).toBe('User backed out');
  });

  test('cannot transition out of terminal state without reset', () => {
    sm.transition('SUCCESS');
    expect(sm.getState()).toBe('SUCCESS');

    // Attempting invalid transition without reset
    sm.transition('CONNECTING_BLE');
    expect(sm.getState()).toBe('SUCCESS'); // Still SUCCESS

    // Reset allows returning to READY
    sm.reset();
    expect(sm.getState()).toBe('READY');
  });
});

