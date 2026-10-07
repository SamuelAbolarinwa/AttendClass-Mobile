import {
  DeviceSecurityService,
  derToCompactSignature,
  compactToDerSignature,
  validateSpkiP256,
} from '../src/services/DeviceSecurityService';
import { SIGNATURE_INTEROP_VECTORS } from '../src/services/SignatureInteropVectors';
import { Buffer } from 'buffer';
import { Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';

describe('Cryptographic Signature Interoperability & Key Safety', () => {
  beforeEach(() => {
    (Keychain as any).__resetMockStorage();
    DeviceSecurityService.__resetSimulatedKeyStore();
  });

  // ── 1. Shared Interoperability Vectors ──────────────────────────────────────
  describe('Shared NIST P-256 Interoperability Vectors', () => {
    SIGNATURE_INTEROP_VECTORS.forEach((vector, idx) => {
      test(`Vector ${idx + 1}: ${vector.description}`, () => {
        // Validate SPKI public key structure
        expect(validateSpkiP256(vector.publicKeySpkiBase64)).toBe(true);

        // 1. Verify ASN.1 DER signature (Android Keystore wire format)
        const derValid = DeviceSecurityService.verifySignature(
          vector.canonicalMessage,
          vector.asn1DerSignatureBase64,
          vector.publicKeySpkiBase64,
        );
        expect(derValid).toBe(vector.expectedValid);

        // 2. Verify 64-byte compact IEEE P1363 signature (WebCrypto / ESP32 format)
        const compactValid = DeviceSecurityService.verifySignature(
          vector.canonicalMessage,
          vector.compactP1363SignatureBase64,
          vector.publicKeySpkiBase64,
        );
        expect(compactValid).toBe(vector.expectedValid);

        if (vector.expectedValid) {
          // 3. Test bi-directional conversion
          const convertedCompact = derToCompactSignature(vector.asn1DerSignatureBase64);
          expect(convertedCompact.length).toBe(64);
          expect(Buffer.from(convertedCompact).toString('base64')).toBe(
            vector.compactP1363SignatureBase64,
          );

          const convertedDer = compactToDerSignature(vector.compactP1363SignatureBase64);
          expect(convertedDer.length).toBeGreaterThanOrEqual(70);
          expect(convertedDer.length).toBeLessThanOrEqual(72);

          // Verify converted DER also validates
          const convertedDerValid = DeviceSecurityService.verifySignature(
            vector.canonicalMessage,
            Buffer.from(convertedDer).toString('base64'),
            vector.publicKeySpkiBase64,
          );
          expect(convertedDerValid).toBe(true);
        }
      });
    });

    test('rejects invalid compact signature lengths', () => {
      const invalidLength = new Uint8Array(63); // 1 byte short
      expect(() => compactToDerSignature(invalidLength)).toThrow(
        'INVALID_COMPACT_SIGNATURE_LENGTH',
      );
    });

    test('rejects non-P256 SPKI public keys', () => {
      // Wrong length
      expect(validateSpkiP256(new Uint8Array(90))).toBe(false);

      // Wrong prefix (RSA or different curve)
      const corruptedPrefix = new Uint8Array(91);
      corruptedPrefix[26] = 0x04;
      expect(validateSpkiP256(corruptedPrefix)).toBe(false);

      // Compressed point (0x02 instead of 0x04)
      const compressedPoint = Buffer.from(
        SIGNATURE_INTEROP_VECTORS[0].publicKeySpkiBase64,
        'base64',
      );
      compressedPoint[26] = 0x02;
      expect(validateSpkiP256(compressedPoint)).toBe(false);
    });
  });

  // ── 2. Key Promotion Safety & Alias Indexing ─────────────────────────────────
  describe('Key Promotion Safety & Alias Indexing', () => {
    const accountId = 'user-test-uuid-888';

    test('generates staging key indexed by credentialId and preserves public key on commit', async () => {
      // 1. Initial enrolment: generate active key
      const initialKey = await DeviceSecurityService.generateDeviceKey(accountId, false);
      expect(initialKey.credentialId).toBeDefined();
      const initialPub = initialKey.publicKeyDerBase64;

      // Active key exists
      expect(await DeviceSecurityService.hasActiveKey(accountId)).toBe(true);
      expect(await DeviceSecurityService.getActivePublicKey(accountId)).toBe(initialPub);

      // 2. Stage replacement key
      const stagedKey = await DeviceSecurityService.generateDeviceKey(accountId, true);
      expect(stagedKey.credentialId).not.toBe(initialKey.credentialId);
      expect(stagedKey.publicKeyDerBase64).not.toBe(initialPub);

      // Staging must NOT overwrite active key before backend confirmation
      expect(await DeviceSecurityService.getActivePublicKey(accountId)).toBe(initialPub);

      // 3. Commit staging key (backend registration succeeded)
      await DeviceSecurityService.commitStagingKey(accountId, stagedKey.credentialId);

      // Active key now points to staged key WITHOUT regenerating the keypair
      const activeAfterCommit = await DeviceSecurityService.getActivePublicKey(accountId);
      expect(activeAfterCommit).toBe(stagedKey.publicKeyDerBase64);

      // Signing uses the newly committed key
      const signRes = await DeviceSecurityService.signData(accountId, 'test-message');
      expect(signRes.success).toBe(true);
      expect(
        DeviceSecurityService.verifySignature(
          'test-message',
          signRes.signatureDerBase64!,
          stagedKey.publicKeyDerBase64,
        ),
      ).toBe(true);
    });

    test('discarding staging key leaves active key completely intact', async () => {
      const activeKey = await DeviceSecurityService.generateDeviceKey(accountId, false);
      const stagedKey = await DeviceSecurityService.generateDeviceKey(accountId, true);

      // Discard staging key (backend enrolment rejected or timed out)
      await DeviceSecurityService.discardStagingKey(accountId, stagedKey.credentialId);

      // Active key is preserved
      expect(await DeviceSecurityService.getActivePublicKey(accountId)).toBe(
        activeKey.publicKeyDerBase64,
      );
      expect(await DeviceSecurityService.hasActiveKey(accountId)).toBe(true);
    });

    test('recovers existing registered key after app restart without re-enrolling', async () => {
      // Generate staging key with specific credentialId
      const customCredId = 'cred_restart_recovery_test_999';
      const keyMeta = await DeviceSecurityService.generateDeviceKey(
        accountId,
        true,
        customCredId,
      );

      // Simulate crash before commitStagingKey: active credential pointer is unset in session
      (DeviceSecurityService as any).activeCredentialPointers.clear();
      expect(await DeviceSecurityService.getActiveCredentialId(accountId)).toBeNull();

      // App restarts, fetches registered credential ID from backend status
      const recovered = await DeviceSecurityService.syncRegisteredCredential(
        accountId,
        customCredId,
      );
      expect(recovered).toBe(true);

      // Active key is now restored to the exact existing keypair without regeneration
      expect(await DeviceSecurityService.getActivePublicKey(accountId)).toBe(
        keyMeta.publicKeyDerBase64,
      );
    });
  });

  // ── 3. Production iOS Safe Rejection ─────────────────────────────────────────
  describe('Platform & Security Enclave Boundaries', () => {
    test('blocks silent simulation on production iOS', async () => {
      const origOS = Platform.OS;

      try {
        (Platform as any).OS = 'ios';
        DeviceSecurityService.__setForceProductionEnvironment(true);

        await expect(
          DeviceSecurityService.generateDeviceKey('user-ios-prod', false),
        ).rejects.toThrow('IOS_SECURE_ENCLAVE_NOT_IMPLEMENTED');
      } finally {
        (Platform as any).OS = origOS;
        DeviceSecurityService.__setForceProductionEnvironment(false);
      }
    });
  });
});
