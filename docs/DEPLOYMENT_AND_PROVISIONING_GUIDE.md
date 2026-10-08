# AttendClass: Deployment and Provisioning Guide

## 1. System Implementation & Readiness Notice

> **Implementation & Verification Status**:
> - Mobile app and cloud backend code have passed automated lint, static analysis, unit test suites, and cryptographic interoperability tests.
> - Hardware flashing to physical ESP32 microcontrollers and live Bluetooth/SD bench validation remain separate testing stages that have **NOT** yet been executed.
> - Systems must not be treated as production-verified until physical hardware and environmental testing are completed.

---

## 2. Environment Configuration

### 2.1 Cloud Backend & Supabase
- **Database**: PostgreSQL 15+ with `pgcrypto` and `uuid-ossp` extensions enabled.
- **Edge Functions**: Deno runtime with Supabase Functions CLI (`supabase/functions/hardware-sync`).
- **Required Supabase Secrets**:
  * `SUPABASE_URL`: Direct HTTPS endpoint to the Supabase instance.
  * `SUPABASE_SERVICE_ROLE_KEY`: Administrative token for database RPC execution.
  * `SUPABASE_ANON_KEY`: Client token for session validation.
  * `HARDWARE_SYNC_SHARED_SECRET`: Authorization bearer secret configured for physical terminals.

### 2.2 Mobile Environment (Android)
- **Runtime**: Node.js v22.x LTS, npm v10.x.
- **Framework**: React Native 0.74.x with Hermes JS Engine.
- **Android SDK**: API Level 34 (compileSdkVersion 34, targetSdkVersion 34, minSdkVersion 26).
- **JDK**: Eclipse Adoptium or Azul Zulu OpenJDK 17.
- **CI Build**: Ubuntu 22.04 LTS (configured in GitHub Actions workflow `.github/workflows/build.yml`).

### 2.3 Physical Terminal (ESP32) Toolchain
- **SoC**: Espressif ESP32-WROOM-32 (Dual-core Xtensa 32-bit LX6, 240 MHz, 520 KB SRAM, 4 MB Flash).
- **Arduino Core**: `esp32` by Espressif Systems v2.0.14+ (or v2.0.17 LTS).
- **Arduino Partition Scheme**: Default 4MB with SPIFFS (`default.csv`: 1.2MB App0, 1.2MB App1, 1.5MB SPIFFS).

---

## 3. Migration and Deployment Order

Execute deployments in strict sequential order to avoid schema divergence:

### Step 1: Database Migrations
Apply migration `0017_device_enrolment_and_offline_attendance.sql` via Supabase CLI:
```bash
supabase db push
# Or apply directly in Supabase SQL Editor:
# supabase/migrations/0017_device_enrolment_and_offline_attendance.sql
```
**Verification**: Confirm `device_activation_codes`, `device_activation_attempt_log`, and columns `event_id`, `terminal_id`, `status` in `attendance_logs` exist.

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

### Step 4: Terminal Provisioning & Firmware Flashing
Compile and flash `firmware/AttendESP_v3/AttendESP_v3.ino` to each physical ESP32 terminal via Arduino IDE or `esptool.py`.

---

## 4. Terminal Provisioning and Credential Setup

Each physical terminal must be provisioned before classroom deployment:

### 4.1 Key Generation
Generate a dedicated NIST P-256 keypair for each terminal:
```bash
# Generate private key
openssl ecparam -name prime256v1 -genkey -noout -out terminal_private.pem
# Extract raw 32-byte private scalar for the terminal SD card
openssl ec -in terminal_private.pem -outform DER | tail -c 32 > terminal_key.bin
# Extract public key in SPKI format
openssl ec -in terminal_private.pem -pubout -out terminal_public.pem
# Convert public key to single-line Base64
grep -v "^-" terminal_public.pem | tr -d "
"
```

### 4.2 Terminal Registration
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

### 4.3 Terminal SD Card Setup
Format an Industrial Grade microSD card (FAT32, <= 32GB) and place the provisioned key file:
```
SD_ROOT/
├── terminal_key.bin         # Mandatory: 32-byte raw private key scalar (terminal fails closed if missing)
├── attendance.csv           # Legacy RFID/Fingerprint log
├── attendance_offline.csv   # Offline BLE signed attendance log
├── event_index.csv          # Event-ID index for deduplication and reconciliation
├── sync_checkpoint.txt      # Persistent outbox line cursor (initialized to 0)
├── rejected_records.csv     # Archive of rejected records
└── enrolled_keys.csv        # Cached authorized student public keys
```

---

## 5. Student Enrolment and Device Lifecycle

### 5.1 Student Device Enrolment Flow
1. **Admin Issues Code**: Administrator navigates to **Admin Portal -> Students -> Manage Device**.
2. **Code Generation**: Clicking **Generate Activation Code** generates an 8-character single-use alphanumeric code valid for 24 hours.
3. **Student Sign-In**: Student logs into the AttendClass Mobile App with their institutional credentials.
4. **Key Generation**: App generates hardware-backed NIST P-256 keypair in Android Keystore.
5. **Backend Registration**: App submits code and SPKI public key to `platform_enroll_device`.
6. **Rate Limiting**: Enrolment attempts are durably tracked in `device_activation_attempt_log`. More than 5 failed attempts in 30 minutes locks out the account.
7. **Cache Synchronization**: On subsequent hardware sync, the terminal fetches the new student credential in `enrolled_keys` and writes it to `/enrolled_keys.csv` on SD.

### 5.2 Phone Replacement Policy
If a student changes their phone:
1. Admin generates a new 24-hour activation code in Admin Portal.
2. Student enrols their new phone.
3. Backend marks previous device as revoked (`revoked_at = now()`).
4. Staged key promotion prevents key loss if app restarts before local promotion.

### 5.3 Revocation & Delayed Record Sync Policy
If a phone is revoked and delayed offline records arrive:
- Provisional phone timestamps (`timestamp_source: 'phone_os'`) are not trusted.
- Records must supply a `terminal_saved_at` timestamp with a valid terminal receipt signature.
- If the terminal receipt signature is missing or fails verification, the record is rejected with `DEVICE_REVOKED_PRIOR_TO_SYNC`.
- If verified, the record is accepted only if `terminal_saved_at < revoked_at`.

---

## 6. Time Semantics & Distinctions

To ensure auditability, AttendClass separates time sources:
- **Phone Occurrence Time** (`phone_attendance_time`): Provisional client timestamp supplied by the student phone.
- **Terminal Storage Time** (`terminal_saved_at`): Authoritative hardware timestamp recorded on the physical terminal at check-in.
- **Server Ingestion Time** (`created_at`): Cloud database timestamp recorded when the batch arrives at Supabase. **This must NOT be described as the actual attendance occurrence time.**

---

## 7. Supported Platforms

| Platform | Support Tier | Security Architecture | Status |
|---|---|---|---|
| **Android 8.0+ (API 26-34)** | Supported | Android Keystore, Class 3 Biometrics or Device Credentials | Implemented in code; bench testing pending |
| **iOS 15.0+** | Deferred / Blocked | Requires native Secure Enclave Swift module with P-256 hardware backing | Blocked from offline attendance until native module is implemented |

---

## 8. Standalone Pilot APK Installation

The pilot release APK is configured to be self-contained:
- Built via `./gradlew assembleRelease` or GitHub Actions workflow `build.yml`.
- JavaScript bundle is pre-packaged (`bundleReleaseJsAndAssets`), requiring no Metro server or laptop connection.
- Falls back to `debug.keystore` if production signing secrets are not configured.
