# AttendClass: Offline BLE Terminal Attendance Protocol Specification

## 1. Overview & Architecture

AttendClass enables students to record verifiable attendance at physical ESP32 terminals over Bluetooth Low Energy (BLE) even when the student phone has no cellular or Wi-Fi internet connectivity.

```
┌──────────────────────────────────────┐
│         AttendClass Mobile           │
│   (Android Keystore, ECDSA P-256)    │
└──────────────────▲───────────────────┘
                   │ BLE (GATT Custom Service)
                   │ Binary MTU-23 Framing
┌──────────────────▼───────────────────┐
│        AttendESP v3 Terminal         │
│     (ESP32, SD Storage, mbedtls)     │
└──────────────────▲───────────────────┘
                   │ HTTPS (DigiCert Root G2 validation)
                   │ Bounded Batch Sync & Checkpoint
┌──────────────────▼───────────────────┐
│        Supabase Cloud Backend        │
│   (Edge Function: hardware-sync)     │
│   (Database: attendance_logs)        │
└──────────────────────────────────────┘
```

---

## 2. Classroom QR Specification & Bluetooth GATT Architecture

### 2.1 Permanent Classroom QR Specification
Each physical ESP32 attendance terminal has a permanent QR code placed on the device casing or classroom wall. It is strictly static and does not rotate.

**JSON Payload**:
```json
{
  "v": 1,
  "type": "attendclass_device",
  "device_id": "ESP32_CS_LAB1",
  "service_uuid": "4e67a100-1234-5678-abcd-0123456789ab",
  "device_key_fingerprint": "sha256:d41d8cd98f00b204e9800998ecf8427e..."
}
```

| Field | Type | Description |
|---|---|---|
| `v` | `number` | Version number (must be `1`). |
| `type` | `string` | Literal identifier (must be `"attendclass_device"`). |
| `device_id` | `string` | Unique physical identifier matching BLE peripheral name. |
| `service_uuid` | `string` | Target BLE Service UUID for direct connection. |
| `device_key_fingerprint` | `string` | Optional SHA-256 fingerprint of the terminal's public key (`sha256:<hex>`). |

---

### 2.2 Bluetooth GATT Architecture & Dual Service Resolution
To support both original and extended firmware profiles, AttendClass automatically discovers and resolves either of the following GATT profiles:

#### Profile A: Primary AttendClass Firmware Profile
| Name | UUID | Type | Properties | Description |
|---|---|---|---|---|
| **Primary Attendance Service** | `4e67a100-1234-5678-abcd-0123456789ab` | Service | N/A | Base attendance service |
| **Write Characteristic** | `4e67a101-1234-5678-abcd-0123456789ab` | Characteristic | Write, Write Without Response | Client sends `HELLO`, `PROOF`, `GET_RESULT` |
| **Notify Characteristic** | `4e67a102-1234-5678-abcd-0123456789ab` | Characteristic | Notify, Indicate, Read | Terminal streams `CHALLENGE`, `RESULT` |

#### Profile B: Secondary / Legacy Characteristic Mapping
| Name | UUID | Type | Properties | Description |
|---|---|---|---|---|
| **Primary Attendance Service** | `0000ff10-0000-1000-8000-00805f9b34fb` | Service | N/A | Base offline attendance service |
| **Challenge Characteristic** | `0000ff11-0000-1000-8000-00805f9b34fb` | Characteristic | Read, Notify | Terminal issues time-bound cryptographic challenge |
| **Submission Characteristic** | `0000ff12-0000-1000-8000-00805f9b34fb` | Characteristic | Write, Write Without Response | Phone transmits signed attendance or reconciliation query |
| **Acknowledgement / Receipt** | `0000ff13-0000-1000-8000-00805f9b34fb` | Characteristic | Read, Notify | Terminal issues durable signed receipt |

---

## 3. Binary Framing & Transport Layer

### 3.1 6-Byte Binary Frame Header
All packets transmitted over Characteristics `0000ff11`, `0000ff12`, and `0000ff13` adhere to the 6-byte binary framing format:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Magic (0xAC) | Version(0x01) |       Transaction ID (16-bit) |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Sequence Num |  Total Chunks |         Data Bytes...         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Byte Offset | Field | Type | Description |
|---|---|---|---|
| `0` | `Magic Byte` | `uint8` | Fixed magic byte: `0xAC` (172) |
| `1` | `Version Byte` | `uint8` | Protocol version: `0x01` (1) |
| `2..3` | `Transaction ID` | `uint16_be` | 16-bit transaction identifier matching `eventId` hash |
| `4` | `Sequence Num` | `uint8` | 1-indexed chunk number (`1 <= seq <= total_chunks`) |
| `5` | `Total Chunks` | `uint8` | Total chunks for payload (`1 <= total <= 255`) |
| `6..N` | `Payload Chunk` | `bytes` | Raw UTF-8 bytes of message chunk |

### 3.2 Transport Sizing & Reassembly Guarantees
- **Minimum MTU**: 23 bytes (effective ATT payload: 20 bytes).
- **Usable chunk per frame at MTU 23**: `20 - 6 = 14 bytes`.
- **Maximum Protocol Payload**: `MAX_PAYLOAD_BYTES = 2048 bytes`.
- **Maximum Frames Required**: `ceil(2048 / 14) = 147 frames`.
- **Sequence Representation**: `147 <= 255`, guaranteeing sequence counters never overflow.
- **Reassembly Buffer**: Chunks are reassembled in strict sequence order `1..total`. Conflicting duplicate chunks abort the transaction. Transactions timeout after 15,000 ms.
- **BLE Callback Decoupling**: Reassembly callbacks push completed messages to background queues (`bleSubmissionQueue`), ensuring non-blocking BLE interrupts.

---

## 4. Message Formats & Cryptographic Verification

### 4.1 Cryptographic Standards
- **Elliptic Curve**: NIST P-256 (`secp256r1` / `prime256v1`).
- **Signature Algorithm**: ECDSA with SHA-256 (`SHA256withECDSA`), enforcing low-S canonicality.
- **Signature Formats**: Raw IEEE P1363 64-byte `(r || s)` Base64 (88 chars), or ASN.1 DER Base64 (70-72 bytes DER).
- **Public Key Format**: Uncompressed NIST P-256 `SubjectPublicKeyInfo` (SPKI) DER Base64 (91 bytes DER, 124 chars Base64, prefix `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...`).

---

### 4.2 AttendClass BLE Protocol v1 Lifecycle

The attendance verification protocol executes in sequential steps:

```
Mobile App (Student)                               ESP32 Terminal
     │                                                    │
     │ 1. HELLO (request_id, student_id, matric)          │
     ├───────────────────────────────────────────────────>│
     │                                                    │
     │ 2. CHALLENGE (nonce, terminal_time, course, sig)   │
     │<───────────────────────────────────────────────────┤
     │                                                    │
     │ [App verifies terminal sig & prompts fingerprint]  │
     │                                                    │
     │ 3. PROOF (challenge, student_id, sig, pub_key)     │
     ├───────────────────────────────────────────────────>│
     │                                                    │
     │ [Terminal verifies student sig & persists to SD]   │
     │                                                    │
     │ 4. RESULT (status: SUCCESS, saved_at, receipt_sig) │
     │<───────────────────────────────────────────────────┤
     │                                                    │
     │ [Optional disconnect recovery]                     │
     │ 5. GET_RESULT (request_id, credential_id)          │
     ├───────────────────────────────────────────────────>│
     │ 6. RESULT (status: SUCCESS/ALREADY_RECORDED)       │
     │<───────────────────────────────────────────────────┤
```

---

### 4.3 Protocol v1 Messages

#### A. HELLO Message (Step 1 - Mobile to ESP32)
```json
{
  "v": 1,
  "type": "HELLO",
  "request_id": "req-9b8c2d1e-4f3a-4a11-b2c3-1a2b3c4d5e6f",
  "student_id": "std-uuid-001",
  "matric_number": "2021/1/12345CP",
  "credential_id": "cred-p256-01"
}
```

#### B. CHALLENGE Message (Step 2 - ESP32 to Mobile)
```json
{
  "v": 1,
  "type": "CHALLENGE",
  "request_id": "req-9b8c2d1e-4f3a-4a11-b2c3-1a2b3c4d5e6f",
  "terminal_id": "ESP32_CS_LAB1",
  "session_id": "sess_20261105_01",
  "challenge": "<32-byte Base64 nonce>",
  "terminal_time": 1793917200,
  "course_code": "CSC401",
  "signature": "<Terminal ECDSA P-256 Signature Base64>"
}
```

**Canonical Challenge Signing Format (`ATTENDCLASS_CHALLENGE_V1`)**:
```
ATTENDCLASS_CHALLENGE_V1|{terminal_id}|{session_id}|{challenge}|{terminal_time}|{course_code}
```
*(Legacy fallback canonical string: `v1|challenge|{terminal_id}|{session_id}|{challenge}|{terminal_time}|{time_confidence}|{course_code}`)*

#### C. PROOF Message (Step 3 - Mobile to ESP32)
```json
{
  "v": 1,
  "type": "PROOF",
  "request_id": "req-9b8c2d1e-4f3a-4a11-b2c3-1a2b3c4d5e6f",
  "credential_id": "cred-p256-01",
  "student_id": "std-uuid-001",
  "matric_number": "2021/1/12345CP",
  "terminal_id": "ESP32_CS_LAB1",
  "session_id": "sess_20261105_01",
  "challenge": "<32-byte Base64 nonce>",
  "timestamp": 1793917205,
  "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...",
  "signature": "<Student Biometric-Gated ECDSA P-256 Signature Base64>"
}
```

**Canonical Proof Signing Format (`ATTENDCLASS_CHECKIN_V1`)**:
```
ATTENDCLASS_CHECKIN_V1|{credential_id}|{student_id}|{terminal_id}|{session_id}|{challenge}|{timestamp}
```
*(Legacy fallback canonical string: `v1|submission|{event_id}|{credential_id}|{credential_version}|{algorithm}|{student_id}|{matric_number}|{terminal_id}|{session_id}|{challenge}|{timestamp}|{timestamp_source}`)*

#### D. RESULT Message (Step 4 - ESP32 to Mobile)
```json
{
  "v": 1,
  "type": "RESULT",
  "request_id": "req-9b8c2d1e-4f3a-4a11-b2c3-1a2b3c4d5e6f",
  "status": "SUCCESS",
  "terminal_id": "ESP32_CS_LAB1",
  "session_id": "sess_20261105_01",
  "saved_at": 1793917206,
  "record_index": 42,
  "signature": "<Terminal ECDSA P-256 Signature Base64>",
  "error_code": null,
  "message": "Attendance verified and durably recorded."
}
```

**Canonical Receipt Signing Format (`ATTENDCLASS_RECEIPT_V1`)**:
```
ATTENDCLASS_RECEIPT_V1|{request_id}|{terminal_id}|{session_id}|{status}|{saved_at}
```
*(Legacy fallback canonical string: `v1|receipt|{event_id}|{terminal_id}|{session_id}|{submission_digest}|{status}|{sd_persisted}|{record_index}|{saved_at}`)*

#### E. GET_RESULT Message (Step 5 - Recovery Query)
```json
{
  "v": 1,
  "type": "GET_RESULT",
  "request_id": "req-9b8c2d1e-4f3a-4a11-b2c3-1a2b3c4d5e6f",
  "credential_id": "cred-p256-01"
}
```

**Persistence Semantics**:
- Emitted ONLY after the complete record is written and flushed to `/attendance_offline.csv` on SD and indexed in `/event_index.csv`.
- If SD write fails, status is `REJECTED`, `sd_persisted: false`, `error_code: "SD_WRITE_FAILURE"`.

---

### 4.5 Disconnect Reconciliation Query
Transmitted by Mobile App over Characteristic `0000ff12` upon reconnecting after a dropped connection.

**Payload (String)**:
```
v1|reconcile|{eventId}|{studentId}
```

**Terminal Handling**:
- Scans `/event_index.csv` for `eventId`.
- If found: Returns the cached signed `DURABLY_SAVED` receipt.
- If not found: Returns `{ "status": "REJECTED", "sd_persisted": false, "error_code": "EVENT_NOT_FOUND" }`.

---

## 5. Offline Storage & Outbox Cloud Synchronization

### 5.1 Storage Layout on SD Card
```
SD_ROOT/
├── attendance.csv           # Legacy 2FA attendance (Card + Fingerprint)
├── enrollment.csv           # Legacy student biometric onboarding
├── attendance_offline.csv   # Signed offline BLE attendance records (16 columns)
├── event_index.csv          # Event index: event_id, matric, digest, saved_at, sig
├── sync_checkpoint.txt      # Persistent outbox line cursor
├── rejected_records.csv     # Archive of records rejected by cloud backend
├── enrolled_keys.csv        # Cached authorized student public keys
└── terminal_key.bin         # Provisioned terminal private scalar (32 bytes)
```

### 5.2 Offline Attendance CSV Schema (16 Columns)
```
event_id,student_id,matric_number,terminal_id,session_id,phone_timestamp,terminal_saved_at,public_key,signature,challenge,timestamp_source,credential_id,credential_version,algorithm,submission_digest,terminal_receipt_signature
```

### 5.3 Batch Sync & Checkpoint Advancement
- Terminals sync batches of up to 10 records at a time.
- The cloud backend returns explicit per-record statuses: `ACCEPTED`, `DUPLICATE`, `REJECTED`, `RETRYABLE`.
- Terminal archives `REJECTED` records to `/rejected_records.csv` with the error reason.
- Terminal advances `sync_checkpoint.txt` only for acknowledged records, pausing if a `RETRYABLE` failure occurs.
- Records appended during synchronization are preserved.
- Credential refresh runs via `x-sync-action: refresh_credentials` before attendance records exist, updating `/enrolled_keys.csv` atomically.

---

## 6. Backend Trust & Revoked Device Policy

- When evaluating delayed records from revoked student devices:
  * Provisional phone timestamps (`timestamp_source: 'phone_os'`) are not trusted.
  * Records must provide a `terminal_saved_at` timestamp.
  * The terminal receipt signature over `terminal_saved_at` and `submission_digest` is cryptographically verified against the terminal's registered public key in `devices`.
  * If the receipt signature is missing or invalid, the record is permanently rejected with `DEVICE_REVOKED_PRIOR_TO_SYNC`.
  * If verified, `terminal_saved_at` is compared against `revoked_at`. If `terminal_saved_at < revoked_at`, the record is `ACCEPTED`; otherwise, `REJECTED`.

---

## 7. Mobile Attendance State Machine (17 States)

The AttendClass mobile application enforces a deterministic 17-state machine:

```
[ READY ] ──> [ SCANNING_QR ] ──> [ QR_VALIDATED ]
                                         │
                                         ▼
[ WAITING_FOR_CHALLENGE ] <── [ VERIFYING_ESP ] <── [ CONNECTING_BLE ] <── [ SEARCHING_DEVICE ]
          │
          ▼
[ WAITING_FOR_BIOMETRIC ] ──> [ SIGNING_CHALLENGE ] ──> [ SENDING_PROOF ]
                                                              │
                                                              ▼
[ SUCCESS / ALREADY_RECORDED ] <── [ VERIFYING_RECEIPT ] <── [ WAITING_FOR_RESULT ]
                                                              │ (disconnect timeout)
                                                              ▼
                                                     [ RECOVERING_RESULT ]
```

| State | Description | Next Permitted States |
|---|---|---|
| `READY` | Default initial state; ready to start check-in | `SCANNING_QR`, `SEARCHING_DEVICE`, `FAILED` |
| `SCANNING_QR` | VisionCamera viewfinder active scanning classroom QR | `QR_VALIDATED`, `CANCELLED`, `FAILED` |
| `QR_VALIDATED` | QR payload parsed and terminal trust verified | `SEARCHING_DEVICE`, `CONNECTING_BLE`, `FAILED` |
| `SEARCHING_DEVICE` | BLE scanning for terminal advertisement | `CONNECTING_BLE`, `CANCELLED`, `FAILED` |
| `CONNECTING_BLE` | GATT connection and MTU negotiation | `VERIFYING_ESP`, `CANCELLED`, `FAILED` |
| `VERIFYING_ESP` | Terminal GATT service discovery | `WAITING_FOR_CHALLENGE`, `CANCELLED`, `FAILED` |
| `WAITING_FOR_CHALLENGE` | Sent `HELLO`, awaiting terminal `CHALLENGE` | `WAITING_FOR_BIOMETRIC`, `CANCELLED`, `FAILED` |
| `WAITING_FOR_BIOMETRIC` | Native BiometricPrompt active | `SIGNING_CHALLENGE`, `CANCELLED`, `FAILED` |
| `SIGNING_CHALLENGE` | Hardware-backed Android Keystore ECDSA signing | `SENDING_PROOF`, `FAILED` |
| `SENDING_PROOF` | Framed binary transmission of `PROOF` over BLE | `WAITING_FOR_RESULT`, `FAILED` |
| `WAITING_FOR_RESULT` | Awaiting terminal `RESULT` acknowledgement | `VERIFYING_RECEIPT`, `RECOVERING_RESULT`, `FAILED` |
| `VERIFYING_RECEIPT` | Verifying terminal ECDSA receipt signature | `SUCCESS`, `ALREADY_RECORDED`, `FAILED` |
| `RECOVERING_RESULT` | Connection interrupted; sending `GET_RESULT` query | `VERIFYING_RECEIPT`, `FAILED` |
| `SUCCESS` | Attendance durably saved and receipt verified | `READY` |
| `ALREADY_RECORDED` | Student already marked for this session | `READY` |
| `FAILED` | Unrecoverable error occurred; error banner displayed | `READY` |
| `CANCELLED` | Aborted by user | `READY` |

---

## 8. Administrative BLE Sync & Bridging

In environments where ESP32 terminals lack active Wi-Fi or internet backhaul:
1. An authorised administrator or course representative logs into AttendClass Mobile with administrative privileges.
2. The phone connects to the ESP32 terminal over BLE.
3. The phone requests pending offline attendance records via batch queries.
4. The phone proxies the signed records securely to the Supabase `hardware-sync` Edge Function.
5. Upon receiving authenticated `ACCEPTED` / `DUPLICATE` confirmations from Supabase, the phone transmits the sync checkpoint back to the ESP32, which advances its `sync_checkpoint.txt` pointer on SD.
6. The terminal remains completely secure: all records retain student and terminal cryptographic signatures that Supabase verifies end-to-end.
