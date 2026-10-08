# AttendClass: Offline BLE Terminal Attendance Protocol Specification

## 1. Overview & Architecture

AttendClass enables students to securely record attendance at physical lecture terminals (ESP32) via Bluetooth Low Energy (BLE) even when the student phone has no cellular or Wi-Fi internet connectivity.

### System Topology
```
┌─────────────────────────────────┐
│        AttendClass Mobile       │
│  (Android Keystore, ECDSA P-256)│
└───────────────▲─────────────────┘
                │ BLE (GATT Custom Service)
                │ Challenge - Response - Signed Receipt
┌───────────────▼─────────────────┐
│       AttendESP v3 Terminal     │
│   (ESP32, SD Storage, mbedtls)  │
└───────────────▲─────────────────┘
                │ HTTPS (TLS with DigiCert Root G2 validation)
                │ Periodic Bounded Batch Sync
┌───────────────▼─────────────────┐
│       Supabase Cloud Backend    │
│  (Edge Function: hardware-sync) │
│  (Database: attendance_logs)    │
└─────────────────────────────────┘
```

---

## 2. Bluetooth GATT Architecture

### 2.1 UUID Definitions
All BLE communications take place over the AttendClass custom 128-bit GATT Service:

| Name | UUID | Type | Properties | Description |
|---|---|---|---|---|
| **Primary Attendance Service** | `0000ff10-0000-1000-8000-00805f9b34fb` | Service | N/A | Base offline attendance service |
| **Challenge Characteristic** | `0000ff11-0000-1000-8000-00805f9b34fb` | Characteristic | Read, Notify | Terminal issues time-bound cryptographic challenge |
| **Submission Characteristic** | `0000ff12-0000-1000-8000-00805f9b34fb` | Characteristic | Write, Write Without Response | Phone transmits signed attendance record |
| **Acknowledgement / Receipt** | `0000ff13-0000-1000-8000-00805f9b34fb` | Characteristic | Read, Notify | Terminal issues durable signed receipt |
| **Legacy Time Sync (v2)** | `0000ff01-0000-1000-8000-00805f9b34fb` | Characteristic | Write | Backward-compatible phone-to-terminal clock sync |

---

## 3. Binary Framing & Transport Layer

### 3.1 Motivation
Standard BLE ATT MTU can be as low as 23 bytes (effective payload: 20 bytes). A full signed attendance submission (~250-350 bytes) or receipt exceeds 20 bytes. The protocol guarantees fragmentation, packet sequencing, duplicate detection, and bounded reassembly over arbitrary MTU sizes (23 to 517 bytes).

### 3.2 6-Byte Binary Frame Header
Every fragment transmitted across GATT characteristics uses a compact 6-byte binary header:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|       Magic 0x41 0x54         |   Msg Type    |  Sequence Num |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Total Frames | Payload Length|         Data Bytes...         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Byte Offset | Field | Type | Description |
|---|---|---|---|
| `0..1` | `Magic` | `uint16_be` | Fixed magic bytes: `0x41 0x54` (ASCII `"AT"`) |
| `2` | `Msg Type` | `uint8` | `0x01`: Challenge, `0x02`: Submission, `0x03`: Receipt, `0x04`: Reconcile |
| `3` | `Sequence Num`| `uint8` | 1-indexed fragment number (`1 <= seq <= total_frames`) |
| `4` | `Total Frames`| `uint8` | Total fragments for message (`1 <= total <= 255`) |
| `5` | `Payload Len` | `uint8` | Number of payload bytes in this fragment (`payload_len <= MTU - 9`) |
| `6..N` | `Payload Chunk`| `bytes` | Binary chunk of UTF-8 or raw message payload |

### 3.3 Connection Bounds & Mathematical Guarantees
- **Minimum MTU**: 23 bytes (effective ATT payload: 20 bytes).
- **Usable chunk per frame at MTU 23**: `20 - 6 = 14 bytes`.
- **Maximum Protocol Payload**: Fixed at `MAX_PAYLOAD_BYTES = 2048 bytes`.
- **Maximum Frames Required**: `ceil(2048 / 14) = 147 frames`.
- **1-Byte Sequence Representation**: $147 \le 255$, ensuring sequence counters will **never overflow** even under worst-case MTU 23 connections.
- **Reassembly Buffer Bounds**: Maximum 2048 bytes allocated per transaction; transactions timeout after 5000 ms. Conflicting fragments (same sequence index with different payload bytes) trigger immediate abort.

---

## 4. Message Formats & Cryptographic Verification

### 4.1 Cryptographic Standards
- **Asymmetric Key Algorithm**: NIST P-256 (`secp256r1` / `prime256v1`).
- **Signature Algorithm**: ECDSA with SHA-256 (`SHA256withECDSA`).
- **Signature Wire Format**: Raw IEEE P1363 64-byte `(r || s)` binary, Base64-encoded (88 chars).
- **Public Key Wire Format**: Uncompressed NIST P-256 `SubjectPublicKeyInfo` (SPKI) DER Base64 (124 chars, prefix `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE`).

---

### 4.2 Terminal Challenge Message
Issued by ESP32 over Characteristic `0000ff11`.

**Wire Format**:
```
ATTCHAL:v1|<terminal_id>|<session_id>|<challenge_nonce>|<monotonic_ms>|<sig_b64>
```

- `terminal_id`: Alphanumeric terminal identifier (e.g., `TERM-LAB1-01`).
- `session_id`: UUID of the active lecture session.
- `challenge_nonce`: 32-character hexadecimal random nonce generated via hardware TRNG.
- `monotonic_ms`: Monotonic milliseconds since terminal boot (`millis()`).
- `sig_b64`: Terminal ECDSA signature over canonical string:
  ```
  ATTCHALLENGE_V1:<terminal_id>:<session_id>:<challenge_nonce>:<monotonic_ms>
  ```
- **Monotonic Expiration**: Terminal strictly rejects any submission where elapsed monotonic time exceeds challenge generation time by more than 60,000 ms (60 seconds).

---

### 4.3 Attendance Submission Message
Transmitted by Mobile App over Characteristic `0000ff12`.

**Wire Format**:
```
ATTSUB:v1|<event_id>|<student_id>|<matric_number>|<session_id>|<phone_timestamp_iso>|<terminal_id>|<challenge_nonce>|<sig_b64>
```

- `event_id`: Unique UUID generated by mobile app prior to transmission.
- `student_id`: Student UUID in AttendClass database.
- `matric_number`: Institutional student matriculation number.
- `session_id`: Verified session UUID matching active challenge.
- `phone_timestamp_iso`: Provisional client timestamp (e.g., `2026-10-08T01:30:00Z`).
- `terminal_id`: Terminal identifier matching active challenge.
- `challenge_nonce`: Challenge nonce received from terminal.
- `sig_b64`: Student device ECDSA signature over canonical string:
  ```
  ATTENDANCE_V1:<event_id>:<student_id>:<matric_number>:<session_id>:<phone_timestamp_iso>:<terminal_id>:<challenge_nonce>
  ```

---

### 4.4 Terminal Acknowledgement / Receipt Message
Emitted by ESP32 over Characteristic `0000ff13` upon writing to SD card.

**Wire Format**:
```
ATTACK:v1|<event_id>|<status>|<terminal_id>|<terminal_ts>|<sig_b64>
```

- `event_id`: UUID matching the submission.
- `status`: One of the following terminal evaluation statuses:
  * `RECORDED_SD`: Valid signature; record successfully flushed to SD.
  * `DUPLICATE_SD`: Identical event previously recorded; acknowledged.
  * `REJECTED_VERIFICATION_FAILED`: ECDSA verification failed or key not enrolled.
  * `REJECTED_SD_FAILURE`: SD card unmounted or I/O write error.
  * `REJECTED_EXPIRED_CHALLENGE`: Challenge expired (> 60s).
- `terminal_id`: Terminal identifier.
- `terminal_ts`: Terminal hardware timestamp (NTP epoch or `BOOT+monotonic_ms`).
- `sig_b64`: Terminal ECDSA signature over canonical string:
  ```
  ATTRECEIPT_V1:<event_id>:<status>:<terminal_id>:<terminal_ts>
  ```

---

### 4.5 Terminal Disconnect Reconciliation Request
Transmitted by Mobile App over Characteristic `0000ff12` if connection drops before receipt is received.

**Wire Format**:
```
ATTREC_REQ:v1|<event_id>|<student_id>|<matric_number>
```
Terminal checks SD event index:
- If `event_id` exists, terminal responds with the cached signed `ATTACK:v1` receipt.
- If `event_id` does not exist, terminal returns `ATTACK:v1|<event_id>|NOT_FOUND|...`.

---

## 5. Mobile Receipt State Machine

The mobile app persists attendance events with explicit lifecycle states:

```
[Start Check-in]
       │
       ▼
[Pre-persist: SUBMISSION_OUTCOME_UNKNOWN] (Durable storage on phone)
       │
       ▼ (BLE Transmission)
[Receive ATTACK:v1 RECORDED_SD]
       │
       ▼
[Update: TERMINAL_CONFIRMED_SD] (Durable on phone, verified terminal signature)
       │
       ▼ (Network connection restored)
[Cloud Reconciliation Sync]
       │
       ├─────────────────────────────────┐
       ▼                                 ▼
[CLOUD_SYNC_PENDING]             [CLOUD_SYNC_CONFIRMED]
(Terminal syncing batch)         (Authoritative DB attendance_log confirmed)
```

> **Critical Safety Rule**: The mobile app NEVER presents an SD receipt as proof of cloud ingestion. The UI displays **"Confirmed on Terminal (Pending Cloud Sync)"** until authoritative verification is completed.

---

## 6. Error Codes and Retry Policies

| Error Code | Layer | Meaning | Mobile Action |
|---|---|---|---|
| `CHALLENGE_TIMEOUT` | Mobile | Terminal challenge was not received within 10s | Abort & retry discovery |
| `CHALLENGE_SIG_INVALID` | Mobile | Terminal signature does not match trusted key | Refuse transmission; untrusted device |
| `CHALLENGE_EXPIRED` | Terminal | Monotonic 60s elapsed before submission received | Request fresh challenge |
| `STUDENT_NOT_ENROLLED` | Terminal | Student public key not found in SD `/enrolled_keys.csv` | Reject with error; prompt student |
| `SIG_VERIFY_FAIL` | Terminal | mbedtls ECDSA verification failed | Reject submission |
| `EVENT_ID_CONFLICT` | Terminal/Cloud | Reused `event_id` with differing payload | Permanently rejected |
| `SD_WRITE_FAIL` | Terminal | SD hardware write/flush error | Terminal displays alert; retryable |
| `DEVICE_REVOKED_PRIOR_TO_SYNC` | Cloud | Student device revoked before terminal recorded attendance | Permanently rejected |
