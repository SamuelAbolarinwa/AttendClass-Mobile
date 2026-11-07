package com.mobileapp.keystore

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.*
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class AndroidKeyStoreModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AndroidKeyStore"

    private val keyStore: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply {
        load(null)
    }

    /**
     * Generate an ECDSA P-256 keypair inside the Android Keystore.
     * The private key is non-exportable and user-authentication-bound.
     */
    @ReactMethod
    fun generateKey(alias: String, requireAuth: Boolean, promise: Promise) {
        try {
            val keyPairGenerator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                "AndroidKeyStore"
            )

            val builder = KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)

            if (requireAuth) {
                builder.setUserAuthenticationRequired(true)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    builder.setUserAuthenticationParameters(
                        0, // Authenticate per signing operation
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
                    )
                } else {
                    @Suppress("DEPRECATION")
                    builder.setUserAuthenticationValidityDurationSeconds(-1)
                }
            }

            keyPairGenerator.initialize(builder.build())
            val keyPair = keyPairGenerator.generateKeyPair()

            // Inspect actual hardware security level
            val factory = KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            val keyInfo = factory.getKeySpec(keyPair.private, KeyInfo::class.java)

            val securityLevel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                when (keyInfo.securityLevel) {
                    KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
                    KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TEE"
                    else -> "SOFTWARE"
                }
            } else {
                if (keyInfo.isInsideSecureHardware) "HARDWARE_TEE" else "SOFTWARE"
            }

            val pubKeyDerBase64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP)

            val result = Arguments.createMap().apply {
                putString("publicKeyDerBase64", pubKeyDerBase64)
                putString("algorithm", "ECDSA_P256_SHA256")
                putString("securityLevel", securityLevel)
                putBoolean("isInsideSecureHardware", keyInfo.isInsideSecureHardware)
            }

            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("KEY_GENERATION_FAILED", e.message, e)
        }
    }

    /**
     * Authorise and sign data using the non-exportable Keystore private key.
     * Uses BiometricPrompt to unlock the signing key via biometrics or device PIN/passcode.
     */
    @ReactMethod
    fun signData(
        alias: String,
        dataBase64: String,
        promptTitle: String,
        promptSubtitle: String,
        promise: Promise
    ) {
        try {
            val privateKeyEntry = keyStore.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            if (privateKeyEntry == null) {
                promise.reject("KEY_NOT_FOUND", "No key found for alias: $alias")
                return
            }

            val rawData = Base64.decode(dataBase64, Base64.DEFAULT)
            val signature = Signature.getInstance("SHA256withECDSA").apply {
                initSign(privateKeyEntry.privateKey)
            }

            // Check if user authentication is required by inspecting KeyInfo
            val factory = KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            val keyInfo = factory.getKeySpec(privateKeyEntry.privateKey, KeyInfo::class.java)

            if (!keyInfo.isUserAuthenticationRequired) {
                // Key does not require biometric gating
                signature.update(rawData)
                val signatureBytes = signature.sign()
                val sigBase64 = Base64.encodeToString(signatureBytes, Base64.NO_WRAP)
                val result = Arguments.createMap().apply {
                    putString("signatureDerBase64", sigBase64)
                    putString("algorithm", "ECDSA_P256_SHA256")
                }
                promise.resolve(result)
                return
            }

            // User authentication required: trigger BiometricPrompt on main thread
            val activity = reactContext.currentActivity as? FragmentActivity
            if (activity == null) {
                promise.reject("NO_ACTIVITY", "Current activity is not available for BiometricPrompt")
                return
            }

            activity.runOnUiThread {
                val executor = ContextCompat.getMainExecutor(activity)
                val promptInfoBuilder = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(promptTitle)
                    .setSubtitle(promptSubtitle)

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // Enforce strong biometrics (fingerprint/Class 3). A device PIN must not silently replace biometrics.
                    promptInfoBuilder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    promptInfoBuilder.setNegativeButtonText("Cancel")
                } else {
                    @Suppress("DEPRECATION")
                    promptInfoBuilder.setNegativeButtonText("Cancel")
                }

                val biometricPrompt = BiometricPrompt(
                    activity,
                    executor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(authResult: BiometricPrompt.AuthenticationResult) {
                            super.onAuthenticationSucceeded(authResult)
                            try {
                                val authenticatedSignature = authResult.cryptoObject?.signature ?: signature
                                authenticatedSignature.update(rawData)
                                val signatureBytes = authenticatedSignature.sign()
                                val sigBase64 = Base64.encodeToString(signatureBytes, Base64.NO_WRAP)

                                val res = Arguments.createMap().apply {
                                    putString("signatureDerBase64", sigBase64)
                                    putString("algorithm", "ECDSA_P256_SHA256")
                                }
                                promise.resolve(res)
                            } catch (e: Exception) {
                                promise.reject("SIGNING_FAILED", e.message, e)
                            }
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            super.onAuthenticationError(errorCode, errString)
                            val code = when (errorCode) {
                                BiometricPrompt.ERROR_USER_CANCELED,
                                BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                                BiometricPrompt.ERROR_CANCELED -> "AUTH_CANCELLED"
                                BiometricPrompt.ERROR_LOCKOUT,
                                BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "AUTH_LOCKOUT"
                                BiometricPrompt.ERROR_NO_BIOMETRICS,
                                BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "NO_CREDENTIAL"
                                else -> "AUTH_FAILED"
                            }
                            promise.reject(code, errString.toString())
                        }

                        override fun onAuthenticationFailed() {
                            super.onAuthenticationFailed()
                            // Single biometric mismatch; prompt stays visible until lockout or cancel
                        }
                    }
                )

                biometricPrompt.authenticate(
                    promptInfoBuilder.build(),
                    BiometricPrompt.CryptoObject(signature)
                )
            }
        } catch (e: Exception) {
            promise.reject("SIGNING_INIT_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun hasKey(alias: String, promise: Promise) {
        try {
            promise.resolve(keyStore.containsAlias(alias))
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getPublicKey(alias: String, promise: Promise) {
        try {
            val cert = keyStore.getCertificate(alias)
            if (cert != null) {
                val pubKey = cert.publicKey
                val pubKeyDerBase64 = Base64.encodeToString(pubKey.encoded, Base64.NO_WRAP)
                promise.resolve(pubKeyDerBase64)
                return
            }
            val privateKeyEntry = keyStore.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            if (privateKeyEntry != null) {
                val pubKey = privateKeyEntry.certificate.publicKey
                val pubKeyDerBase64 = Base64.encodeToString(pubKey.encoded, Base64.NO_WRAP)
                promise.resolve(pubKeyDerBase64)
                return
            }
            promise.reject("KEY_NOT_FOUND", "No key or certificate found for alias: $alias")
        } catch (e: Exception) {
            promise.reject("GET_PUBKEY_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun deleteKey(alias: String, promise: Promise) {
        try {
            if (keyStore.containsAlias(alias)) {
                keyStore.deleteEntry(alias)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("DELETE_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun getSecurityLevel(alias: String, promise: Promise) {
        try {
            val privateKeyEntry = keyStore.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            if (privateKeyEntry == null) {
                promise.resolve("NONE")
                return
            }
            val factory = KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            val keyInfo = factory.getKeySpec(privateKeyEntry.privateKey, KeyInfo::class.java)

            val level = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                when (keyInfo.securityLevel) {
                    KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
                    KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TEE"
                    else -> "SOFTWARE"
                }
            } else {
                if (keyInfo.isInsideSecureHardware) "HARDWARE_TEE" else "SOFTWARE"
            }
            promise.resolve(level)
        } catch (e: Exception) {
            promise.resolve("UNKNOWN")
        }
    }
}
