import { LocalApprovalService } from '../src/services/LocalApprovalService';

describe('Local Approval & Identity Policy', () => {
  test('correctly classifies user cancellation', () => {
    const error = new Error('User canceled the biometric prompt.');
    const classified = LocalApprovalService.classifyAuthError(error);
    expect(classified.code).toBe('AUTH_CANCELLED');
  });

  test('correctly classifies biometric lockout', () => {
    const error = new Error('Biometrics locked out due to too many attempts.');
    const classified = LocalApprovalService.classifyAuthError(error);
    expect(classified.code).toBe('AUTH_LOCKOUT');
  });

  test('correctly classifies missing credentials or passcode', () => {
    const error = new Error('No credentials enrolled on device.');
    const classified = LocalApprovalService.classifyAuthError(error);
    expect(classified.code).toBe('NO_CREDENTIAL');
  });

  test('correctly classifies hardware unavailable', () => {
    const error = new Error('Biometric hardware is not supported or unavailable.');
    const classified = LocalApprovalService.classifyAuthError(error);
    expect(classified.code).toBe('HARDWARE_NOT_SUPPORTED');
  });

  test('checks runtime capabilities properly', async () => {
    const caps = await LocalApprovalService.checkCapabilities();
    expect(caps.canAuthenticate).toBe(true);
    expect(caps.capability).toBe('BIOMETRICS_AVAILABLE');
  });
});
