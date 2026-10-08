# AttendClass: Deployment and Provisioning Guide

## 1. Environment Configuration

### 1.1 Cloud Backend & Supabase
- **Database**: PostgreSQL 15+ with `pgcrypto` and `uuid-ossp` extensions enabled.
- **Edge Functions**: Deno runtime with Supabase Functions CLI (`supabase/functions/hardware-sync`).
- **Required Supabase Secrets**:
  * `SUPABASE_URL`: Direct HTTPS endpoint to the Supabase instance.
  * `SUPABASE_SERVICE_ROLE_KEY`: Administrative token for database RPC execution.
  * `SUPABASE_ANON_KEY`: Client token for session validation.
  * `HARDWARE_SYNC_SHARED_SECRET`: Authorization bearer secret configured for physical terminals.

### 1.2 Mobile Development & Build Environment
- **Runtime**: Node.js v22.x LTS, npm v10.x.
- **Framework**: React Native 0.74.x with Hermes JS Engine.
- **Android SDK**: API Level 34 (compileSdkVersion 34, targetSdkVersion 34, minSdkVersion 26).
- **JDK**: Eclipse Adoptium or Azul Zulu OpenJDK 17.
- **Build Machine**: Ubuntu 22.04 LTS (configured in GitHub Actions workflow `.github/workflows/build.yml`).

### 1.3 Physical Terminal (ESP32) Toolchain
- **SoC**: Espressif ESP32-WROOM-32 (Dual-core Xtensa 32-bit LX6, 240 MHz, 520 KB SRAM, 4 MB Flash).
- **Arduino Core**: `esp32` by Espressif Systems v2.0.14+ (or v2.0.17 LTS).
- **Arduino Partition Scheme**: Default 4MB with SPIFFS (`default.csv`: 1.2MB App0, 1.2MB App1, 1.5MB SPIFFS).

---

## 2. Migration and Deployment Order

Execute deployments in strict sequential order to avoid schema divergence:

### Step 1: Database Migrations
Apply migration `0017_device_enrolment_and_offline_attendance.sql` via Supabase CLI:
```bash
supabase db push
# Or apply directly in Supabase SQL Editor:
# supabase/migrations/0017_device_enrolment_and_offline_attendance.sql
```
**Verification**: Check that `device_activation_codes`, `device_activation_attempt_log`, and columns `event_id`, `terminal_id`, `status` in `attendance_logs` exist.

### Step 2: Supabase Edge Functions Deployment
Deploy the updated `hardware-sync` function:
```bash
supabase functions deploy hardware-sync --no-verify-jwt
```
**Verification**: Test interoperability vectors using:
```bash
npm run test:interop
```

### Step 3: Web-App Admin Portal Deployment
Build and deploy the management portal containing the `DeviceManagementModal`:
```bash
npm run build
# Deploy dist/ to hosting provider (Vercel, Supabase Hosting, or Netlify)
```

### Step 4: Terminal Firmware Flashing
Compile and flash `firmware/AttendESP_v3/AttendESP_v3.ino` to each physical ESP32 terminal via Arduino IDE or `esptool.py`.

---

## 3. Terminal Provisioning and Credential Updates

Each physical terminal must be initialized before classroom deployment:

### 3.1 Key Generation
Generate a dedicated NIST P-256 keypair for each terminal:
```bash
# Generate private key
openssl ecparam -name prime256v1 -genkey -noout -out terminal_private.pem
# Extract public key in SPKI format
openssl ec -in terminal_private.pem -pubout -out terminal_public.pem
# Convert public key to single-line Base64
grep -v "^-" terminal_public.pem | tr -d "
"
```

### 3.2 Terminal Registration
Insert the terminal into the `devices` table:
```sql
INSERT INTO devices (device_id, name, location, public_key, algorithm, is_active)
VALUES (
  'TERM-LAB1-01',
  'Computer Science Lab Terminal 1',
  'Block B, Room 204',
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...<124-char SPKI Base64>...',
  'ECDSA_P256_SHA256',
  true
);
```

### 3.3 Terminal SD Card Provisioning
Format an Industrial Grade microSD card (FAT32, <= 32GB) and create the initial directory structure:
```
SD_ROOT/
├── attendance.csv           (Legacy RFID/Fingerprint log)
├── attendance_offline.csv   (New Offline BLE signed attendance log)
├── event_index.csv          (Event-ID index for deduplication and reconciliation)
├── enrolled_keys.csv        (Authorized student public keys cache)
└── sync_checkpoint.txt      (Durable upload cursor offset)
```

### 3.4 Trust Anchor Configuration
The terminal firmware (`AttendESP_v3.ino`) embeds the DigiCert Root G2 CA root certificate in `server_root_ca`. Ensure the terminal network can reach the Supabase HTTPS endpoint over port 443 with SNI.

---

## 4. Student Enrolment and Device Lifecycle

### 4.1 First Student Device Enrolment
1. **Admin Issues Code**: An administrator navigates to **Admin Portal -> Students -> Manage Device**.
2. **Code Generation**: Clicking **Generate Activation Code** invokes `admin_generate_device_activation_code`, producing an 8-character single-use alphanumeric code (e.g., `A7B9K2M4`) valid for 24 hours.
3. **Student Sign-In**: Student logs into the AttendClass Mobile App using their institutional credentials.
4. **Key Generation**: The mobile app calls Android Keystore / Biometrics to create a hardware-backed NIST P-256 keypair.
5. **Backend Registration**: The app submits the 8-character code and the uncompressed SPKI public key to `platform_enroll_device`.
6. **Rate Limiting**: Enrolment attempts are durably tracked in `device_activation_attempt_log`. More than 5 failed attempts in 30 minutes locks out the account.
7. **Cache Synchronization**: On the next periodic hardware sync, the terminal fetches the new student credential in `enrolled_keys` and appends it to `/enrolled_keys.csv` on SD.

### 4.2 Phone Replacement Policy
If a student changes or loses their phone:
1. Admin generates a new 24-hour activation code in the Admin Portal.
2. The student signs in on their new phone and submits the new code.
3. Backend atomically marks the previous device as revoked (`revoked_at = now()`) and registers the new device key.
4. **Staged Key Promotion**: In the mobile app, if an app crash occurs between backend enrolment and local key promotion, `checkPendingEnrolmentPromotion()` automatically recovers and activates the staging key.

### 4.3 Revocation & Delayed Record Sync Policy
If a phone is revoked (e.g. reported compromised or lost) and delayed offline records subsequently arrive from an ESP32 terminal:
- If the terminal record has a trusted terminal timestamp (`terminal_rtc` synced via NTP) recorded **before** the device revocation time, the record is **ACCEPTED**.
- If the record relies solely on provisional phone time (`timestamp_source: phone_os`) and arrives after device revocation, the cloud backend **REJECTS** the record with reason `DEVICE_REVOKED_PRIOR_TO_SYNC`.

---

## 5. Offline Time Handling & Limitations

Physical ESP32 terminals operate without an on-board coin-cell Battery-Backed Real-Time Clock (RTC):
- **Monotonic Clock**: The internal hardware tick counter (`millis()`) runs monotonically from boot.
- **Challenge Expiration**: Challenges are issued with `monotonic_ms` and expire after **60 seconds** of monotonic time. This guarantees replay protection even when the system calendar clock is completely unset.
- **Calendar Clock Synchronization**:
  * When Wi-Fi is active, the terminal synchronizes UTC time via NTP (`pool.ntp.org`) and updates `ntpSyncEpoch`.
  * If a phone connects over BLE, it may write UTC epoch to Characteristic `0000ff01` (Legacy Time Sync), setting the provisional terminal clock.
  * The terminal records the time source in every log entry: `NTP`, `PHONE_BLE`, or `BOOT_MONOTONIC`.
- **Authoritative Ingestion**: The Supabase database timestamp (`created_at`) remains the authoritative legal record timestamp.

---

## 6. Supported Platforms

| Platform | Support Tier | Security Architecture | Status |
|---|---|---|---|
| **Android 8.0+ (API 26-34)** | **Production Ready** | Android Keystore / StrongBox, Class 3 Biometrics (BiometricPrompt) or Device PIN/Pattern/Password | Fully Implemented & Tested |
| **iOS 15.0+** | **Deferred / Blocked** | Requires native Secure Enclave Swift module with P-256 hardware backing | Blocked from production offline attendance until native module is implemented |

---

## 7. Pilot APK Installation & Distribution

To evaluate AttendClass in a classroom pilot without requiring a development laptop or Metro connection:

### 7.1 Self-Contained Release APK
The project is configured so that `./gradlew assembleRelease` bundles all React Native JavaScript assets and fonts into the APK:
- Bundling command executed during Gradle build: `bundleReleaseJsAndAssets`
- Embedded asset path: `assets/index.android.bundle`
- Keystore configuration: Falls back to `debug.keystore` if `release.keystore` is not present, producing an installable standalone pilot APK.

### 7.2 GitHub Actions Artifact Download
Every commit on branch `feat/attendclass-offline-ble-terminal` triggers `.github/workflows/build.yml`:
1. Navigate to **GitHub Repository -> Actions -> Build Android APK**.
2. Select the latest successful workflow run.
3. Download the artifact: `app-release-<commit-sha>.zip`.
4. Extract `app-release.apk` and transfer to Android test devices via USB or Google Drive.
5. On the phone, enable **Install unknown apps** for Files/Chrome and install `app-release.apk`.
