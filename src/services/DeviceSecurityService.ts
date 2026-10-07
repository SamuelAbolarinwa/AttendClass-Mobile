/* eslint-disable no-bitwise */
import { NativeModules, Platform } from 'react-native';
import { p256 } from '@noble/curves/nist.js';
import { Buffer } from 'buffer';
import * as Keychain from 'react-native-keychain';
import { DiagnosticLogger } from './DiagnosticLogger';
import { LocalApprovalErrorCode } from './LocalApprovalService';

export interface DeviceKeyMetadata {
  publicKeyDerBase64: string;
  algorithm: 'ECDSA_P256_SHA256';
  credentialId: string;
  credentialVersion: string;
  securityLevel: 'STRONGBOX' | 'TEE' | 'HARDWARE_TEE' | 'SOFTWARE' | 'SIMULATOR_TEST';
  isInsideSecureHardware: boolean;
  createdAtIso: string;
}

export interface SignDataResult {
  success: boolean;
  signatureDerBase64?: string;
  algorithm: 'ECDSA_P256_SHA256';
  securityLevel?: string;
  errorCode?: LocalApprovalErrorCode | 'KEY_NOT_FOUND' | 'SIGNING_FAILED';
  errorMessage?: string;
}

// In-memory / Keychain simulation store for Jest and simulator test runs
interface SimulatedKeyEntry {
  privateKeyBytes: Uint8Array;
  publicKeyDerBase64: string;
  credentialId: string;
  createdAtIso: string;
  requireAuth: boolean;
  securityLevel: 'SIMULATOR_TEST';
}

const simulatedKeyStore = new Map<string, SimulatedKeyEntry>();

// NIST P-256 curve order n and half n
export const SECP256R1_N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
export const SECP256R1_HALF_N = SECP256R1_N >> 1n;

// SPKI header for secp256r1 (id-ecPublicKey + secp256r1 OID + BIT STRING wrapper)
export const SPKI_P256_PREFIX_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

/**
 * Validate that bytes represent a valid uncompressed NIST P-256 SPKI public key.
 * Expected structure: 91 bytes, standard ASN.1 header (26 bytes) + 0x04 uncompressed point (65 bytes).
 */
export function validateSpkiP256(spkiInput: Uint8Array | string): boolean {
  try {
    const bytes = typeof spkiInput === 'string' ? Buffer.from(spkiInput, 'base64') : Buffer.from(spkiInput);
    if (bytes.length !== 91) return false;
    const prefixHex = Buffer.from(bytes.subarray(0, 26)).toString('hex');
    if (prefixHex !== SPKI_P256_PREFIX_HEX) return false;
    if (bytes[26] !== 0x04) return false;
    return true;
  } catch {
    return false;
  }
}

// DER encoding helpers for ECDSA P-256
export function encodeDERSignature(r: bigint, s: bigint): Uint8Array {
  function toIntegerDer(num: bigint): number[] {
    let hex = num.toString(16);
    if (hex.length % 2 !== 0) hex = '0' + hex;
    const bytes = Array.from(Buffer.from(hex, 'hex'));
    if (bytes[0] >= 0x80) bytes.unshift(0x00);
    return [0x02, bytes.length, ...bytes];
  }
  const rDer = toIntegerDer(r);
  const sDer = toIntegerDer(s);
  const body = [...rDer, ...sDer];
  return new Uint8Array([0x30, body.length, ...body]);
}

export function decodeDERSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let offset = 2;
  if (der[0] !== 0x30) throw new Error('Invalid DER signature sequence header');
  if (der[1] & 0x80) {
    const lenBytes = der[1] & 0x7f;
    offset = 2 + lenBytes;
  }
  if (der[offset++] !== 0x02) throw new Error('Expected INTEGER tag for R');
  const rLen = der[offset++];
  const rBytes = der.subarray(offset, offset + rLen);
  offset += rLen;
  if (der[offset++] !== 0x02) throw new Error('Expected INTEGER tag for S');
  const sLen = der[offset++];
  const sBytes = der.subarray(offset, offset + sLen);
  const r = BigInt('0x' + Buffer.from(rBytes).toString('hex'));
  const s = BigInt('0x' + Buffer.from(sBytes).toString('hex'));
  return { r, s };
}

/**
 * Convert ASN.1 DER ECDSA signature into 64-byte raw IEEE P1363 (R || S) format.
 * Canonicalizes S to low-S form.
 */
export function derToCompactSignature(derInput: Uint8Array | string): Uint8Array {
  const derBytes = typeof derInput === 'string' ? Buffer.from(derInput, 'base64') : Buffer.from(derInput);
  if (derBytes.length === 64) {
    return new Uint8Array(derBytes);
  }
  const { r, s } = decodeDERSignature(derBytes);
  const canonicalS = s > SECP256R1_HALF_N ? SECP256R1_N - s : s;

  const compact = new Uint8Array(64);
  const rHex = r.toString(16).padStart(64, '0');
  const sHex = canonicalS.toString(16).padStart(64, '0');
  compact.set(Buffer.from(rHex, 'hex'), 0);
  compact.set(Buffer.from(sHex, 'hex'), 32);
  return compact;
}

/**
 * Convert 64-byte raw IEEE P1363 (R || S) signature into ASN.1 DER format.
 * Validates scalar ranges [1, n-1] and enforces low-S.
 */
export function compactToDerSignature(compactInput: Uint8Array | string): Uint8Array {
  const compact = typeof compactInput === 'string' ? Buffer.from(compactInput, 'base64') : Buffer.from(compactInput);
  if (compact.length !== 64) {
    throw new Error(`INVALID_COMPACT_SIGNATURE_LENGTH: Expected 64 bytes, got ${compact.length}`);
  }
  const rHex = Buffer.from(compact.subarray(0, 32)).toString('hex');
  const sHex = Buffer.from(compact.subarray(32, 64)).toString('hex');
  const r = BigInt('0x' + rHex);
  const s = BigInt('0x' + sHex);

  if (r <= 0n || r >= SECP256R1_N || s <= 0n || s >= SECP256R1_N) {
    throw new Error('SIGNATURE_OUT_OF_RANGE: R or S is not within [1, n-1]');
  }

  const canonicalS = s > SECP256R1_HALF_N ? SECP256R1_N - s : s;
  return encodeDERSignature(r, canonicalS);
}

export class DeviceSecurityService {
  public static readonly CREDENTIAL_VERSION = 'v1';
  public static readonly ALGORITHM: 'ECDSA_P256_SHA256' = 'ECDSA_P256_SHA256';

  private static activeCredentialPointers = new Map<string, string>(); // accountId -> credentialId
  private static stagingCredentialStore = new Map<string, string>(); // accountId -> staged credentialId
  private static __forceProductionEnvironmentForTesting = false;

  /**
   * For testing: force production environment flag to test platform safeguards
   */
  public static __setForceProductionEnvironment(force: boolean): void {
    this.__forceProductionEnvironmentForTesting = force;
  }

  /**
   * Derive Keystore alias permanently indexed by credential ID.
   * Avoids key regeneration during promotion.
   */
  public static getCredentialAlias(credentialId: string): string {
    return `attendclass_keystore_cred_${credentialId}`;
  }

  /**
   * Derive canonical alias for an account's active signing key.
   */
  public static getActiveAlias(accountId: string): string {
    const credId = this.activeCredentialPointers.get(accountId);
    if (credId) {
      return this.getCredentialAlias(credId);
    }
    return `attendclass_keystore_active_${accountId}`;
  }

  /**
   * Derive canonical alias for staging a new key during enrolment or replacement.
   */
  public static getStagingAlias(accountId: string): string {
    const stagedId = this.stagingCredentialStore.get(accountId);
    if (stagedId) {
      return this.getCredentialAlias(stagedId);
    }
    return `attendclass_keystore_stage_${accountId}`;
  }

  public static async getActiveCredentialId(accountId: string): Promise<string | null> {
    if (this.activeCredentialPointers.has(accountId)) {
      return this.activeCredentialPointers.get(accountId)!;
    }
    try {
      const res = await Keychain.getGenericPassword({
        service: `attendclass_cred_ptr_${accountId}`,
      });
      if (res && res.password) {
        this.activeCredentialPointers.set(accountId, res.password);
        return res.password;
      }
    } catch {
      // ignore
    }
    return null;
  }

  public static async setActiveCredentialId(accountId: string, credentialId: string): Promise<void> {
    this.activeCredentialPointers.set(accountId, credentialId);
    try {
      await Keychain.setGenericPassword('account', credentialId, {
        service: `attendclass_cred_ptr_${accountId}`,
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    } catch {
      // ignore
    }
  }

  /**
   * Compute fingerprint/credential ID from public key DER Base64 (SHA-256).
   */
  public static computeCredentialId(publicKeyDerBase64: string): string {
    const raw = Buffer.from(publicKeyDerBase64, 'base64');
    const digest = (p256 as any).hash(raw);
    return Buffer.from(digest).toString('hex').substring(0, 32);
  }

  /**
   * Check if native Android Keystore module is loaded.
   */
  private static isNativeAndroidKeyStoreAvailable(): boolean {
    return (
      Platform.OS === 'android' &&
      !!NativeModules.AndroidKeyStore &&
      typeof NativeModules.AndroidKeyStore.generateKey === 'function'
    );
  }

  /**
   * Generate an OS-level ECDSA P-256 keypair.
   * On Android, creates a non-exportable key in Android Keystore with biometric gating,
   * indexed permanently by credential ID so key promotion never regenerates the keypair.
   */
  public static async generateDeviceKey(
    accountId: string,
    isStaging = false,
    customCredentialId?: string,
  ): Promise<DeviceKeyMetadata> {
    const credentialId =
      customCredentialId ||
      `cred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const alias = this.getCredentialAlias(credentialId);

    if (isStaging) {
      this.stagingCredentialStore.set(accountId, credentialId);
    }

    if (this.isNativeAndroidKeyStoreAvailable()) {
      try {
        const result = await NativeModules.AndroidKeyStore.generateKey(alias, true);

        DiagnosticLogger.info('KEYSTORE', 'Generated native Android Keystore key', {
          alias,
          credentialId,
          securityLevel: result.securityLevel,
          isInsideSecureHardware: result.isInsideSecureHardware,
        });

        if (!isStaging) {
          await this.setActiveCredentialId(accountId, credentialId);
        }

        return {
          publicKeyDerBase64: result.publicKeyDerBase64,
          algorithm: this.ALGORITHM,
          credentialId,
          credentialVersion: this.CREDENTIAL_VERSION,
          securityLevel: result.securityLevel,
          isInsideSecureHardware: !!result.isInsideSecureHardware,
          createdAtIso: new Date().toISOString(),
        };
      } catch (err: unknown) {
        DiagnosticLogger.warn('KEYSTORE', 'Native Keystore generation error, falling back', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // iOS and Simulator validation
    if (Platform.OS === 'ios') {
      const isTestOrDev =
        !DeviceSecurityService.__forceProductionEnvironmentForTesting &&
        ((typeof __DEV__ !== 'undefined' && __DEV__) ||
          ((globalThis as any)?.process?.env?.NODE_ENV === 'test') ||
          typeof jest !== 'undefined');
      if (!isTestOrDev) {
        throw new Error(
          'IOS_SECURE_ENCLAVE_NOT_IMPLEMENTED: Production iOS requires native Apple Secure Enclave bridge. Software simulation is blocked.',
        );
      }
    }

    const priv = p256.utils.randomSecretKey();
    const uncompressedPub = p256.getPublicKey(priv, false); // 65 bytes: 0x04 || X || Y
    const spkiPrefix = Buffer.from(SPKI_P256_PREFIX_HEX, 'hex');
    const fullSpki = Buffer.concat([spkiPrefix, Buffer.from(uncompressedPub)]);
    const pubBase64 = fullSpki.toString('base64');

    simulatedKeyStore.set(alias, {
      privateKeyBytes: priv,
      publicKeyDerBase64: pubBase64,
      credentialId,
      createdAtIso: new Date().toISOString(),
      requireAuth: true,
      securityLevel: 'SIMULATOR_TEST',
    });

    if (!isStaging) {
      await this.setActiveCredentialId(accountId, credentialId);
    }

    DiagnosticLogger.info('KEYSTORE', 'Generated simulation ECDSA P-256 key', {
      alias,
      credentialId,
      securityLevel: 'SIMULATOR_TEST',
    });

    return {
      publicKeyDerBase64: pubBase64,
      algorithm: this.ALGORITHM,
      credentialId,
      credentialVersion: this.CREDENTIAL_VERSION,
      securityLevel: 'SIMULATOR_TEST',
      isInsideSecureHardware: false,
      createdAtIso: new Date().toISOString(),
    };
  }

  /**
   * Commit staging key to active status after backend registration succeeds.
   * Updates Keychain active credential pointer without altering the Keystore private key.
   */
  public static async commitStagingKey(accountId: string, explicitCredentialId?: string): Promise<void> {
    const credId = explicitCredentialId || this.stagingCredentialStore.get(accountId);
    if (!credId) {
      return;
    }

    await this.setActiveCredentialId(accountId, credId);
    this.stagingCredentialStore.delete(accountId);
    DiagnosticLogger.info('KEYSTORE', `Committed staging key pointer for account ${accountId}`, { credId });
  }

  /**
   * Discard staging key on failed activation attempt without altering active key.
   */
  public static async discardStagingKey(accountId: string, explicitCredentialId?: string): Promise<void> {
    const credId = explicitCredentialId || this.stagingCredentialStore.get(accountId);
    if (!credId) return;

    const alias = this.getCredentialAlias(credId);
    if (this.isNativeAndroidKeyStoreAvailable()) {
      await NativeModules.AndroidKeyStore.deleteKey(alias).catch(() => {});
    }
    simulatedKeyStore.delete(alias);
    this.stagingCredentialStore.delete(accountId);
    DiagnosticLogger.info('KEYSTORE', `Discarded staging key for account ${accountId}`, { credId });
  }

  /**
   * Recover an already-registered credential on startup after an interruption.
   * If the key exists in Keystore, points active credential to it without re-enrolling.
   */
  public static async syncRegisteredCredential(
    accountId: string,
    registeredCredentialId: string,
  ): Promise<boolean> {
    const exists = await this.hasCredentialKey(registeredCredentialId);
    if (exists) {
      await this.setActiveCredentialId(accountId, registeredCredentialId);
      return true;
    }
    return false;
  }

  public static async hasCredentialKey(credentialId: string): Promise<boolean> {
    const alias = this.getCredentialAlias(credentialId);
    if (this.isNativeAndroidKeyStoreAvailable()) {
      try {
        return await NativeModules.AndroidKeyStore.hasKey(alias);
      } catch {
        return false;
      }
    }
    return simulatedKeyStore.has(alias);
  }

  /**
   * Check if an active key exists for this account.
   */
  public static async hasActiveKey(accountId: string): Promise<boolean> {
    const credId = await this.getActiveCredentialId(accountId);
    if (credId) {
      return this.hasCredentialKey(credId);
    }
    const legacyAlias = `attendclass_keystore_active_${accountId}`;
    if (this.isNativeAndroidKeyStoreAvailable()) {
      try {
        return await NativeModules.AndroidKeyStore.hasKey(legacyAlias);
      } catch {
        return false;
      }
    }
    return simulatedKeyStore.has(legacyAlias);
  }

  /**
   * Sign canonical attendance challenge bound to OS authentication.
   * If user cancels or locks out, no signature is generated.
   */
  public static async signData(
    accountId: string,
    canonicalMessage: string,
    promptTitle = 'Authorise Attendance Check-in',
    promptSubtitle = 'Authenticate with fingerprint or PIN to sign attendance',
  ): Promise<SignDataResult> {
    const alias = this.getActiveAlias(accountId);
    const dataBase64 = Buffer.from(canonicalMessage, 'utf-8').toString('base64');

    if (this.isNativeAndroidKeyStoreAvailable()) {
      try {
        const res = await NativeModules.AndroidKeyStore.signData(
          alias,
          dataBase64,
          promptTitle,
          promptSubtitle,
        );
        return {
          success: true,
          signatureDerBase64: res.signatureDerBase64,
          algorithm: this.ALGORITHM,
        };
      } catch (err: unknown) {
        const errorStr = String(err);
        let code: LocalApprovalErrorCode | 'KEY_NOT_FOUND' | 'SIGNING_FAILED' = 'SIGNING_FAILED';
        if (errorStr.includes('AUTH_CANCELLED') || errorStr.includes('User canceled')) {
          code = 'AUTH_CANCELLED';
        } else if (errorStr.includes('AUTH_LOCKOUT')) {
          code = 'AUTH_LOCKOUT';
        } else if (errorStr.includes('KEY_NOT_FOUND')) {
          code = 'KEY_NOT_FOUND';
        } else if (errorStr.includes('NO_CREDENTIAL')) {
          code = 'NO_CREDENTIAL';
        }
        return {
          success: false,
          algorithm: this.ALGORITHM,
          errorCode: code,
          errorMessage: err instanceof Error ? err.message : errorStr,
        };
      }
    }

    // Simulation signing
    const entry = simulatedKeyStore.get(alias);
    if (!entry) {
      return {
        success: false,
        algorithm: this.ALGORITHM,
        errorCode: 'KEY_NOT_FOUND',
        errorMessage: 'Device key not found in storage. Enrolment required.',
      };
    }

    try {
      const msgBytes = Buffer.from(canonicalMessage, 'utf-8');
      const compactSig = p256.sign(msgBytes, entry.privateKeyBytes);
      const sigObj = p256.Signature.fromBytes(compactSig);
      const derSig = encodeDERSignature(sigObj.r, sigObj.s);
      const signatureDerBase64 = Buffer.from(derSig).toString('base64');

      return {
        success: true,
        signatureDerBase64,
        algorithm: this.ALGORITHM,
        securityLevel: 'SIMULATOR_TEST',
      };
    } catch (e: unknown) {
      return {
        success: false,
        algorithm: this.ALGORITHM,
        errorCode: 'SIGNING_FAILED',
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Verify an ECDSA P-256 DER or IEEE P1363 compact signature against SPKI DER public key.
   */
  public static verifySignature(
    canonicalMessage: string,
    signatureBase64: string,
    publicKeySpkiBase64: string,
  ): boolean {
    try {
      const pubBytes = Buffer.from(publicKeySpkiBase64, 'base64');
      let uncompressedPub: Uint8Array;
      if (pubBytes.length === 91 && pubBytes[0] === 0x30) {
        uncompressedPub = pubBytes.subarray(26);
      } else if (pubBytes.length === 65 && pubBytes[0] === 0x04) {
        uncompressedPub = pubBytes;
      } else {
        return false;
      }

      const compactSig = derToCompactSignature(signatureBase64);
      const msgBytes = Buffer.from(canonicalMessage, 'utf-8');
      return p256.verify(compactSig, msgBytes, uncompressedPub);
    } catch {
      return false;
    }
  }

  /**
   * Retrieve active public key DER Base64 for the specified account.
   */
  public static async getActivePublicKey(accountId: string): Promise<string | null> {
    const credId = await this.getActiveCredentialId(accountId);
    const alias = credId ? this.getCredentialAlias(credId) : this.getActiveAlias(accountId);
    if (simulatedKeyStore.has(alias)) {
      return simulatedKeyStore.get(alias)!.publicKeyDerBase64;
    }
    // If native, key exists in Keystore
    return null;
  }

  /**
   * Delete key upon explicit user revocation.
   */
  public static async deleteKey(accountId: string): Promise<void> {
    const credId = await this.getActiveCredentialId(accountId);
    const alias = credId ? this.getCredentialAlias(credId) : this.getActiveAlias(accountId);
    const stageAlias = this.getStagingAlias(accountId);
    if (this.isNativeAndroidKeyStoreAvailable()) {
      await NativeModules.AndroidKeyStore.deleteKey(alias).catch(() => {});
      await NativeModules.AndroidKeyStore.deleteKey(stageAlias).catch(() => {});
    }
    simulatedKeyStore.delete(alias);
    simulatedKeyStore.delete(stageAlias);
    this.activeCredentialPointers.delete(accountId);
    this.stagingCredentialStore.delete(accountId);
    try {
      await Keychain.resetGenericPassword({ service: `attendclass_cred_ptr_${accountId}` });
    } catch {
      // ignore
    }
  }

  /**
   * For testing: Reset in-memory simulation keys and credential pointers.
   */
  public static __resetSimulatedKeyStore(): void {
    simulatedKeyStore.clear();
    this.activeCredentialPointers.clear();
    this.stagingCredentialStore.clear();
  }
}
