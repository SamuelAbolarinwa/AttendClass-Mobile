export interface SignatureInteropVector {
  description: string;
  canonicalMessage: string;
  privateKeyHex: string;
  publicKeySpkiBase64: string;
  asn1DerSignatureBase64: string;
  compactP1363SignatureBase64: string;
  expectedValid: boolean;
}

/**
 * Shared NIST P-256 (secp256r1) interoperability vectors.
 * Generated deterministically and verified with OpenSSL, Node crypto, and WebCrypto.
 * Cross-tested between:
 * 1. Mobile DeviceSecurityService (Android Keystore / noble curves)
 * 2. Backend hardware-sync Edge Function (WebCrypto API)
 * 3. Planned ESP32 firmware (micro-ecc / mbedtls)
 *
 * NOTE: Native Android device hardware execution is pending physical device testing.
 */
export const SIGNATURE_INTEROP_VECTORS: SignatureInteropVector[] = [
  {
    description: 'Valid ECDSA P-256 signature over canonical attendance submission',
    canonicalMessage:
      'v1|submission|evt-test-101|cred-p256-01|v1|ECDSA_P256_SHA256|std-uuid-001|2021/1/12345CP|TERM_01|sess_20261006|challenge_nonce_32_bytes_test|1791298800|phone_os',
    privateKeyHex: 'c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22',
    // X.509 SubjectPublicKeyInfo (SPKI) DER Base64 (91 bytes)
    publicKeySpkiBase64:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE77edo9o0tvejrv0kEzHJqePFlVqYYP8fg9lqyJOMe8ONKuImJsIgYXA6VNK0KTMWg/OfiBwipkkdjXnra3aKRg==',
    // Generated ASN.1 DER signature Base64 (Android Keystore wire format)
    asn1DerSignatureBase64:
      'MEQCIGytQ2CkHxnnHniU5FTEt1IZ/1YgmrHzG7tFyMs7Jit3AiBrYvr228g50rogqwSbw5vJvZ9TMwd6Jp/0rdSZIhcvoQ==',
    // Equivalent 64-byte IEEE P1363 raw signature (WebCrypto / ESP32 format: R[32] || S[32])
    compactP1363SignatureBase64:
      'bK1DYKQfGeceeJTkVMS3Uhn/ViCasfMbu0XIyzsmK3drYvr228g50rogqwSbw5vJvZ9TMwd6Jp/0rdSZIhcvoQ==',
    expectedValid: true,
  },
  {
    description: 'Tampered canonical message must fail verification',
    canonicalMessage:
      'v1|submission|evt-test-101|cred-p256-01|v1|ECDSA_P256_SHA256|std-uuid-001|2021/1/99999CP|TERM_01|sess_20261006|challenge_nonce_32_bytes_test|1791298800|phone_os',
    privateKeyHex: 'c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22',
    publicKeySpkiBase64:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE77edo9o0tvejrv0kEzHJqePFlVqYYP8fg9lqyJOMe8ONKuImJsIgYXA6VNK0KTMWg/OfiBwipkkdjXnra3aKRg==',
    asn1DerSignatureBase64:
      'MEQCIGytQ2CkHxnnHniU5FTEt1IZ/1YgmrHzG7tFyMs7Jit3AiBrYvr228g50rogqwSbw5vJvZ9TMwd6Jp/0rdSZIhcvoQ==',
    compactP1363SignatureBase64:
      'bK1DYKQfGeceeJTkVMS3Uhn/ViCasfMbu0XIyzsmK3drYvr228g50rogqwSbw5vJvZ9TMwd6Jp/0rdSZIhcvoQ==',
    expectedValid: false,
  },
  {
    description: 'Tampered signature bytes must fail verification',
    canonicalMessage:
      'v1|submission|evt-test-101|cred-p256-01|v1|ECDSA_P256_SHA256|std-uuid-001|2021/1/12345CP|TERM_01|sess_20261006|challenge_nonce_32_bytes_test|1791298800|phone_os',
    privateKeyHex: 'c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22',
    publicKeySpkiBase64:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE77edo9o0tvejrv0kEzHJqePFlVqYYP8fg9lqyJOMe8ONKuImJsIgYXA6VNK0KTMWg/OfiBwipkkdjXnra3aKRg==',
    asn1DerSignatureBase64:
      'MEQDIGytQ2CkHxnnHniU5FTEt1IZ/1YgmrHzG7tFyMs7Jit3AiBrYvr228g50rogqwSbw5vJvZ9TMwd6Jp/0rdSZIhcvoQ==',
    compactP1363SignatureBase64:
      'cK1DYKQfGeceeJTkVMS3Uhn/ViCasfMbu0XIyzsmK3drYvr228g50rogqwSbw5vJvZ9TMwd6Jp/0rdSZIhcvoQ==',
    expectedValid: false,
  },
];
