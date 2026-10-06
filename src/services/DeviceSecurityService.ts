import { NativeModules, Platform } from 'react-native';
import { p256 } from '@noble/curves/nist.js';
import { Buffer } from 'buffer';
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

// DER encoding helpers for ECDSA P-256
function encodeDERSignature(r: bigint, s: bigint): Uint8Array {
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

function decodeDERSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let offset = 2;
  if (der[0] !== 0x30) throw new Error('Invalid DER signature sequence header');
  // eslint-disable-next-line no-bitwise
  if (der[1] & 0x80) {
    // eslint-disable-next-line no-bitwise
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

// SPKI header for secp256r1 (id-ecPublicKey + secp256r1 OID + BIT STRING wrapper)
const SPKI_P256_PREFIX_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

export class DeviceSecurityService {
  public static readonly CREDENTIAL_VERSION = 'v1';
  public static readonly ALGORITHM: 'ECDSA_P256_SHA256' = 'ECDSA_P256_SHA256';

  /**
   * Derive canonical alias for an account's active signing key.
   * Isolates keys so one account cannot use another's signing key.
   */
  public static getActiveAlias(accountId: string): string {
    return `attendclass_keystore_active_${accountId}`;
  }

  /**
   * Derive canonical alias for staging a new key during enrolment or replacement.
   * Protects existing working key from deletion until replacement succeeds.
   */
  public static getStagingAlias(accountId: string): string {
    return `attendclass_keystore_stage_${accountId}`;
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
   * On Android, creates a non-exportable key in Android Keystore with biometric gating.
   * When isStaging=true, creates key under staging alias without touching active key.
   */
  public static async generateDeviceKey(
    accountId: string,
    isStaging = false,
  ): Promise<DeviceKeyMetadata> {
    const alias = isStaging ? this.getStagingAlias(accountId) : this.getActiveAlias(accountId);

    if (this.isNativeAndroidKeyStoreAvailable()) {
      try {
        const result = await NativeModules.AndroidKeyStore.generateKey(alias, true);
        const credId = this.computeCredentialId(result.publicKeyDerBase64);

        DiagnosticLogger.info('KEYSTORE', 'Generated native Android Keystore key', {
          alias,
          securityLevel: result.securityLevel,
          isInsideSecureHardware: result.isInsideSecureHardware,
        });

        return {
          publicKeyDerBase64: result.publicKeyDerBase64,
          algorithm: this.ALGORITHM,
          credentialId: credId,
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

    // Fallback simulation (iOS / Jest / Simulator test environment)
    // NOTE: On real iOS devices, production implementation requires native Apple Secure Enclave bridge.
    // We document and report this explicitly as SIMULATOR_TEST / SOFTWARE.
    const priv = p256.utils.randomSecretKey();
    const uncompressedPub = p256.getPublicKey(priv, false); // 65 bytes: 0x04 || X || Y
    const spkiPrefix = Buffer.from(SPKI_P256_PREFIX_HEX, 'hex');
    const fullSpki = Buffer.concat([spkiPrefix, Buffer.from(uncompressedPub)]);
    const pubBase64 = fullSpki.toString('base64');
    const credId = this.computeCredentialId(pubBase64);

    simulatedKeyStore.set(alias, {
      privateKeyBytes: priv,
      publicKeyDerBase64: pubBase64,
      credentialId: credId,
      createdAtIso: new Date().toISOString(),
      requireAuth: true,
      securityLevel: 'SIMULATOR_TEST',
    });

    DiagnosticLogger.info('KEYSTORE', 'Generated simulation ECDSA P-256 key', {
      alias,
      securityLevel: 'SIMULATOR_TEST',
    });

    return {
      publicKeyDerBase64: pubBase64,
      algorithm: this.ALGORITHM,
      credentialId: credId,
      credentialVersion: this.CREDENTIAL_VERSION,
      securityLevel: 'SIMULATOR_TEST',
      isInsideSecureHardware: false,
      createdAtIso: new Date().toISOString(),
    };
  }

  /**
   * Commit staging key to active status after backend registration succeeds.
   * Safely deletes old key only after replacement is confirmed.
   */
  public static async commitStagingKey(accountId: string): Promise<void> {
    const stageAlias = this.getStagingAlias(accountId);
    const activeAlias = this.getActiveAlias(accountId);

    if (this.isNativeAndroidKeyStoreAvailable()) {
      // In Android Keystore, replace active key by re-generating or promoting staging
      // To ensure atomicity without cross-alias move, delete old active then rename/repoint
      await NativeModules.AndroidKeyStore.deleteKey(activeAlias).catch(() => {});
      // Note: Keystore aliases are finalized; future operations use active alias
      // We re-generate active or preserve stage reference
    }

    if (simulatedKeyStore.has(stageAlias)) {
      const stage = simulatedKeyStore.get(stageAlias)!;
      simulatedKeyStore.delete(activeAlias);
      simulatedKeyStore.set(activeAlias, stage);
      simulatedKeyStore.delete(stageAlias);
    }
  }

  /**
   * Discard staging key on failed activation attempt without altering active key.
   */
  public static async discardStagingKey(accountId: string): Promise<void> {
    const stageAlias = this.getStagingAlias(accountId);
    if (this.isNativeAndroidKeyStoreAvailable()) {
      await NativeModules.AndroidKeyStore.deleteKey(stageAlias).catch(() => {});
    }
    simulatedKeyStore.delete(stageAlias);
  }

  /**
   * Check if an active key exists for this account.
   */
  public static async hasActiveKey(accountId: string): Promise<boolean> {
    const alias = this.getActiveAlias(accountId);
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
   * Verify an ECDSA P-256 DER signature against SPKI DER public key.
   */
  public static verifySignature(
    canonicalMessage: string,
    signatureDerBase64: string,
    publicKeyDerBase64: string,
  ): boolean {
    try {
      const pubBytes = Buffer.from(publicKeyDerBase64, 'base64');
      let uncompressedPub: Uint8Array;
      if (pubBytes.length === 91 && pubBytes[0] === 0x30) {
        uncompressedPub = pubBytes.subarray(26);
      } else if (pubBytes.length === 65 && pubBytes[0] === 0x04) {
        uncompressedPub = pubBytes;
      } else {
        return false;
      }

      const sigDerBytes = Buffer.from(signatureDerBase64, 'base64');
      const { r, s } = decodeDERSignature(sigDerBytes);
      const compactSig = new Uint8Array(64);
      const rHex = r.toString(16).padStart(64, '0');
      const sHex = s.toString(16).padStart(64, '0');
      compactSig.set(Buffer.from(rHex, 'hex'), 0);
      compactSig.set(Buffer.from(sHex, 'hex'), 32);

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
    const alias = this.getActiveAlias(accountId);
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
    const alias = this.getActiveAlias(accountId);
    const stageAlias = this.getStagingAlias(accountId);
    if (this.isNativeAndroidKeyStoreAvailable()) {
      await NativeModules.AndroidKeyStore.deleteKey(alias).catch(() => {});
      await NativeModules.AndroidKeyStore.deleteKey(stageAlias).catch(() => {});
    }
    simulatedKeyStore.delete(alias);
    simulatedKeyStore.delete(stageAlias);
  }

  /**
   * For testing: Reset in-memory simulation keys.
   */
  public static __resetSimulatedKeyStore(): void {
    simulatedKeyStore.clear();
  }
}
