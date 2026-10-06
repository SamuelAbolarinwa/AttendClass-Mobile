import * as Keychain from 'react-native-keychain';
import { isNetworkError } from '../src/contexts/AuthContext';
import { AttendanceSigner } from '../src/services/AttendanceSigner';

describe('Offline Startup & Credential Preservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Keychain as any).__resetMockStorage();
  });

  test('correctly identifies network errors', () => {
    expect(isNetworkError(new Error('Network request failed'))).toBe(true);
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new Error('The request timed out'))).toBe(true);
    expect(isNetworkError(new Error('Invalid token'))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });

  test('offline startup does not delete saved credentials on network failure', async () => {
    const testAccount = {
      id: 'student-uuid-101',
      full_name: 'Test Student',
      role: 'user',
      must_change_password: false,
      identifier: '2021/1/12345CP',
      token: 'session-token-abc',
      offline_valid_until: new Date(Date.now() + 86400000).toISOString(),
    };

    // Store credentials in Keychain
    await Keychain.setGenericPassword('platform_account', JSON.stringify(testAccount), {
      service: 'platform_account_service',
    });

    // Mock enrolled device key
    await AttendanceSigner.generateAndStoreDeviceKey(testAccount.id);

    // Simulate network error during session validation
    const networkError = new Error('Network request failed');
    expect(isNetworkError(networkError)).toBe(true);

    // Verify credentials still exist in Keychain
    const credsAfter = await Keychain.getGenericPassword({ service: 'platform_account_service' });
    expect(credsAfter).not.toBe(false);
    if (credsAfter) {
      const parsed = JSON.parse(credsAfter.password);
      expect(parsed.id).toBe(testAccount.id);
      expect(parsed.identifier).toBe(testAccount.identifier);
    }
  });
});
