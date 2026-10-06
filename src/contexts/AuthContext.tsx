import React, { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { supabase } from '../lib/supabase';
import { AttendanceSigner } from '../services/AttendanceSigner';
import { DiagnosticLogger } from '../services/DiagnosticLogger';

export type AuthStatus =
  | 'ONLINE_AUTHENTICATED'
  | 'OFFLINE_AUTHORISED'
  | 'CREDENTIAL_EXPIRED_OR_REVOKED'
  | 'SIGNED_OUT';

export interface Account {
  id: string;
  full_name: string;
  role: 'user' | 'manager' | 'administrator';
  must_change_password: boolean;
  identifier: string;
  token: string;
  matric_number?: string;
  last_online_verified_at?: string;
  offline_valid_until?: string; // ISO string, maximum 7 days offline lease
}

export interface AuthState {
  account: Account | null;
  authStatus: AuthStatus;
  loading: boolean;
  isDeviceEnrolled: boolean;
  hasMobileEnrollment: boolean;
  errorMessage: string | null;
  signIn: (identifier: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  updateAccount: (updates: Partial<Account>) => void;
  forceSetPassword: (currentPass: string, newPass: string) => Promise<{ error: string | null }>;
  enrollDeviceWithCode: (activationCode: string, deviceName?: string) => Promise<{ error: string | null }>;
  checkDeviceEnrolment: () => Promise<boolean>;
  setHasMobileEnrollment: (val: boolean) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

const OFFLINE_LEASE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days maximum offline validity policy

export function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('network request failed') ||
    msg.includes('network error') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('failed to fetch') ||
    msg.includes('abort') ||
    msg.includes('internet')
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>('SIGNED_OUT');
  const [loading, setLoading] = useState(true);
  const [isDeviceEnrolled, setIsDeviceEnrolled] = useState(false);
  const [hasMobileEnrollment, setHasMobileEnrollment] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const saveAccount = async (acct: Account | null) => {
    try {
      if (acct) {
        await Keychain.setGenericPassword('platform_account', JSON.stringify(acct), {
          service: 'platform_account_service',
          accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
      } else {
        await Keychain.resetGenericPassword({ service: 'platform_account_service' });
      }
    } catch (err: unknown) {
      DiagnosticLogger.warn('AUTH', 'Failed saving account to Keychain', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const checkDeviceEnrolment = useCallback(async (): Promise<boolean> => {
    if (!account?.id) return false;
    const enrolled = await AttendanceSigner.hasEnrolledDeviceKey(account.id);
    setIsDeviceEnrolled(enrolled);
    return enrolled;
  }, [account?.id]);

  useEffect(() => {
    async function loadAccount() {
      try {
        setLoading(true);
        const credentials = await Keychain.getGenericPassword({ service: 'platform_account_service' });
        if (!credentials || !credentials.password) {
          setAccount(null);
          setAuthStatus('SIGNED_OUT');
          return;
        }

        const storedAccount = JSON.parse(credentials.password) as Account;
        const hasDeviceKey = await AttendanceSigner.hasEnrolledDeviceKey(storedAccount.id);
        setIsDeviceEnrolled(hasDeviceKey);

        // Attempt online validation with Supabase
        try {
          const { data, error } = await supabase.rpc('platform_verify_session', {
            p_token: storedAccount.token,
          });

          if (error) {
            // Check if error is due to network failure, gateway, or timeout vs backend database rejection
            const errMsg = (error.message || '').toLowerCase();
            const isGatewayOrTransient =
              errMsg.includes('502') ||
              errMsg.includes('503') ||
              errMsg.includes('504') ||
              errMsg.includes('bad gateway') ||
              errMsg.includes('gateway timeout') ||
              errMsg.includes('connection refused') ||
              isNetworkError(error);

            if (isGatewayOrTransient) {
              throw error; // Let outer network catch handle offline policy
            }

            // Explicit backend failure -> Revoked or invalid session
            DiagnosticLogger.warn('AUTH', 'Session rejected by backend', { error: error.message });
            setAccount(storedAccount);
            setAuthStatus('CREDENTIAL_EXPIRED_OR_REVOKED');
            setErrorMessage('Your session has expired. Please sign in again.');
            return;
          }

          const result = data as { valid?: boolean; account_id?: string } | null;
          if (result && result.valid) {
            // Online session is valid! Renew offline lease
            const now = new Date();
            const updatedAccount: Account = {
              ...storedAccount,
              last_online_verified_at: now.toISOString(),
              offline_valid_until: new Date(now.getTime() + OFFLINE_LEASE_DURATION_MS).toISOString(),
            };

            setAccount(updatedAccount);
            setAuthStatus('ONLINE_AUTHENTICATED');
            await saveAccount(updatedAccount);

            // Check face enrollment status online
            try {
              const { data: enrData, error: enrError } = await supabase.rpc('platform_has_active_enrollment', {
                p_token: storedAccount.token,
                p_model_version: 'mobilefacenet-mobile-v1',
              });
              if (!enrError && (enrData as { has_active?: boolean })?.has_active) {
                setHasMobileEnrollment(true);
              }
            } catch {
              // Non-blocking face check failure
            }
          } else {
            // Explicitly invalid or revoked
            DiagnosticLogger.warn('AUTH', 'Session token invalid or revoked');
            setAccount(storedAccount);
            setAuthStatus('CREDENTIAL_EXPIRED_OR_REVOKED');
            setErrorMessage('Your session was revoked or expired. Please sign in.');
          }
        } catch (networkErr: unknown) {
          // Network failure: Evaluate Defined Offline Authorization Policy
          // CRITICAL: NEVER delete saved credentials merely because a request times out or the phone is offline!
          DiagnosticLogger.info('AUTH', 'Network unreachable during startup, evaluating offline policy', {
            error: networkErr instanceof Error ? networkErr.message : String(networkErr),
          });

          const now = Date.now();
          const validUntil = storedAccount.offline_valid_until ? new Date(storedAccount.offline_valid_until).getTime() : 0;
          const isWithinLease = validUntil > now;

          if (hasDeviceKey && isWithinLease) {
            // Authorized offline access policy satisfied
            setAccount(storedAccount);
            setAuthStatus('OFFLINE_AUTHORISED');
            setErrorMessage(null);
          } else if (hasDeviceKey && !isWithinLease) {
            // Offline lease expired
            setAccount(storedAccount);
            setAuthStatus('CREDENTIAL_EXPIRED_OR_REVOKED');
            setErrorMessage('Offline access lease has expired. Please connect to internet to re-verify.');
          } else {
            // Device key not enrolled yet
            setAccount(storedAccount);
            setAuthStatus('OFFLINE_AUTHORISED');
            setErrorMessage('Device enrolment required before offline attendance can be used.');
          }
        }
      } catch (err: unknown) {
        DiagnosticLogger.warn('AUTH', 'Failed to load account from Keychain', {
          error: err instanceof Error ? err.message : String(err),
        });
        setAccount(null);
        setAuthStatus('SIGNED_OUT');
      } finally {
        setLoading(false);
      }
    }

    loadAccount();
  }, []);

  const signIn = useCallback(async (identifier: string, password: string) => {
    setLoading(true);
    setErrorMessage(null);

    try {
      const { data, error } = await supabase.rpc('platform_login', {
        p_identifier: identifier.trim(),
        p_password: password,
      });

      if (error) {
        setLoading(false);
        return { error: error.message };
      }

      const result = data as Record<string, unknown>;
      if (!result || !result.ok) {
        setLoading(false);
        return { error: (result?.error as string) || 'Login failed. Invalid identifier or password.' };
      }

      const now = new Date();
      const acct: Account = {
        id: result.id as string,
        full_name: result.full_name as string,
        role: result.role as Account['role'],
        must_change_password: Boolean(result.must_change_password),
        identifier: result.identifier as string,
        token: result.token as string,
        matric_number: result.matric_number ? String(result.matric_number) : undefined,
        last_online_verified_at: now.toISOString(),
        offline_valid_until: new Date(now.getTime() + OFFLINE_LEASE_DURATION_MS).toISOString(),
      };

      setAccount(acct);
      setAuthStatus('ONLINE_AUTHENTICATED');
      await saveAccount(acct);

      // Check device key enrolment for this account
      const hasKey = await AttendanceSigner.hasEnrolledDeviceKey(acct.id);
      setIsDeviceEnrolled(hasKey);

      // Check face enrollment
      try {
        const { data: enrData, error: enrError } = await supabase.rpc('platform_has_active_enrollment', {
          p_token: acct.token,
          p_model_version: 'mobilefacenet-mobile-v1',
        });
        setHasMobileEnrollment(!enrError && (enrData as { has_active?: boolean })?.has_active === true);
      } catch {
        setHasMobileEnrollment(false);
      }

      setLoading(false);
      return { error: null };
    } catch (e: unknown) {
      setLoading(false);
      const msg = e instanceof Error ? e.message : 'Network error during login';
      return { error: msg };
    }
  }, []);

  const signOut = useCallback(async () => {
    setLoading(true);
    if (account?.token) {
      try {
        await supabase.rpc('platform_logout', { p_token: account.token });
      } catch (err: unknown) {
        DiagnosticLogger.warn('AUTH', 'Logout RPC failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    setAccount(null);
    setAuthStatus('SIGNED_OUT');
    setIsDeviceEnrolled(false);
    setHasMobileEnrollment(false);
    await saveAccount(null);
    setLoading(false);
  }, [account]);

  const updateAccount = useCallback((updates: Partial<Account>) => {
    setAccount((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...updates };
      saveAccount(next);
      return next;
    });
  }, []);

  const forceSetPassword = useCallback(
    async (currentPass: string, newPass: string) => {
      if (!account?.token) return { error: 'No active session token' };

      setLoading(true);
      try {
        const { data, error } = await supabase.rpc('platform_force_set_password', {
          p_token: account.token,
          p_current_password: currentPass,
          p_new_password: newPass,
        });

        setLoading(false);
        if (error) return { error: error.message };

        const result = data as { ok?: boolean; error?: string } | null;
        if (!result || !result.ok) {
          return { error: result?.error || 'Failed to update password' };
        }

        updateAccount({ must_change_password: false });
        return { error: null };
      } catch (err: unknown) {
        setLoading(false);
        return { error: err instanceof Error ? err.message : 'Error updating password' };
      }
    },
    [account, updateAccount],
  );

  const enrollDeviceWithCode = useCallback(
    async (activationCode: string, deviceName?: string): Promise<{ error: string | null }> => {
      if (!account?.id || !account.token) {
        return { error: 'Sign-in required to enroll device.' };
      }

      setLoading(true);
      try {
        // 1. Generate new ECDSA P-256 signing key in provisional staging slot
        // Does NOT overwrite or delete any existing working active key
        const keyMetadata = await AttendanceSigner.generateAndStoreDeviceKey(account.id, true);

        // 2. Call backend RPC to validate one-time activation code and bind public key
        const { data, error } = await supabase.rpc('platform_enroll_device', {
          p_token: account.token,
          p_activation_code: activationCode.trim().toUpperCase(),
          p_device_public_key: keyMetadata.publicKeyDerBase64,
          p_platform: Platform.OS,
          p_device_name: deviceName || (Platform.OS === 'android' ? 'Android Device' : 'iOS Device'),
        });

        if (error) {
          // Discard staging key on error without affecting active key
          await AttendanceSigner.discardStagingKey(account.id);
          setLoading(false);
          return { error: error.message };
        }

        const res = data as { ok?: boolean; error?: string } | null;
        if (!res || !res.ok) {
          // Discard staging key on business logic error without affecting active key
          await AttendanceSigner.discardStagingKey(account.id);
          setLoading(false);
          return { error: res?.error || 'Device enrolment failed.' };
        }

        // 3. Backend validated code and registered device: commit staging key to active
        await AttendanceSigner.commitStagingKey(account.id);
        setIsDeviceEnrolled(true);

        DiagnosticLogger.info('AUTH', 'Device successfully enrolled with admin activation code', {
          accountId: account.id,
          securityLevel: keyMetadata.securityLevel,
        });

        setLoading(false);
        return { error: null };
      } catch (err: unknown) {
        await AttendanceSigner.discardStagingKey(account.id).catch(() => {});
        setLoading(false);
        const msg = err instanceof Error ? err.message : 'Error during device enrolment';
        return { error: msg };
      }
    },
    [account],
  );

  return (
    <AuthContext.Provider
      value={{
        account,
        authStatus,
        loading,
        isDeviceEnrolled,
        hasMobileEnrollment,
        errorMessage,
        signIn,
        signOut,
        updateAccount,
        forceSetPassword,
        enrollDeviceWithCode,
        checkDeviceEnrolment,
        setHasMobileEnrollment,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
