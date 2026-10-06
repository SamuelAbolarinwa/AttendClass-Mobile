# AttendClass Mobile App

This is the React Native (Bare CLI) client for the AttendClass platform, supporting persistent authentication, admin-approved device enrolment, and offline Bluetooth Low Energy (BLE) attendance transactions with the physical ESP32 attendance terminal.

## Core Features
- **Persistent Authentication & Offline Authorisation**: Resilient against network timeouts and offline mode. Validates session online when connected and adheres to a bounded 7-day offline lease policy without deleting saved credentials on network failure.
- **Admin-Approved Phone Enrolment**: Generates hardware-backed Ed25519 device signing keys. Binds one active device to an account via single-use, short-lived admin activation codes. Device replacement revokes older keys and invalidates stale sessions.
- **Local Approval & Identity Policy**: Authorises transaction signing via OS biometric prompt (Fingerprint / Face ID) with deliberate screen-lock PIN/passcode fallback. Handles lockout, cancellation, and missing hardware gracefully while preserving terminal-side identity verifications.
- **Offline BLE Attendance Protocol**:
  - Connects to AttendClass Terminal BLE Service (`0000FF10-0000-1000-8000-00805F9B34FB`).
  - Reads fresh, unpredictable challenge from Characteristic `FF11`.
  - Submits canonically formatted Ed25519 signed transaction via Characteristic `FF12`.
  - Awaits durable SD persistence acknowledgement (`DURABLY_SAVED`, `sd_persisted: true`) via Characteristic `FF13`.
  - Prohibits mock successes: success is ONLY displayed when the terminal confirms persistent save.
- **Durable Local Receipts & Lagos Calendar Boundaries**: Persists attendance receipts locally with provenance (attendance time, local receipt time, cloud upload time) normalized to `Africa/Lagos` (UTC+1).
- **Diagnostics**: Redacted transaction logging with stage durations, error codes, and version tagging.

---

## Prerequisites
- Node.js >= 22.11.0
- React Native environment (Android SDK / platform-tools `adb`)
- Connected Android phone (API 26+) or emulator

---

## Running and Testing Locally

### 1. Install Dependencies & Verify Build
```bash
npm install
npm run lint       # ESLint check (0 errors)
npx tsc --noEmit   # TypeScript static type check (0 errors)
npm test           # Jest test suite (all tests passing)
```

### 2. Local Testing on Android Phone (No Android Studio Needed)
You can test on a physical Android phone using only `adb` and the Metro bundler:

1. **Enable USB Debugging** on your phone (Settings -> Developer Options -> USB Debugging).
2. **Download or build the debug APK**:
   ```bash
   # Download app-debug-<sha>.apk from GitHub Actions or build locally:
   cd android && ./gradlew assembleDebug && cd ..
   ```
3. **Install the debug APK** via ADB:
   ```bash
   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
   ```
4. **Reverse the Metro bundler port**:
   ```bash
   adb reverse tcp:8081 tcp:8081
   ```
5. **Start Metro bundler**:
   ```bash
   npm start
   ```
6. Open **AttendClass** on your phone. Code changes in JavaScript and React will hot-reload immediately via Fast Refresh.

---

## Physical Hardware Integration (ESP32 Terminal)

The mobile client expects the classroom attendance terminal to expose:
- **BLE Service UUID**: `0000FF10-0000-1000-8000-00805F9B34FB` (Advertised name: `AttendESP_*` or `TERM_*`)
- **Challenge Characteristic (`FF11`, Read/Notify)**: Emits JSON challenge with unpredictable 32-byte challenge, `terminal_id`, `session_id`, and `terminal_time`.
- **Submission Characteristic (`FF12`, Write)**: Accepts base64 encoded JSON payload containing `event_id`, `student_id`, `matric_number`, `timestamp`, `public_key`, and Ed25519 `signature`.
- **Acknowledgement Characteristic (`FF13`, Read/Notify)**: Persists attendance row to SD card (`attendance.csv`), flushes write, and returns:
  ```json
  {
    "version": 1,
    "event_id": "<event_id>",
    "status": "DURABLY_SAVED",
    "sd_persisted": true,
    "record_index": 42,
    "saved_at": 1791298802
  }
  ```
- **Terminal Cloud Sync**: Terminal periodically synchronises SD attendance records to Supabase via its own internet connection (`POST /functions/v1/hardware-sync`).
