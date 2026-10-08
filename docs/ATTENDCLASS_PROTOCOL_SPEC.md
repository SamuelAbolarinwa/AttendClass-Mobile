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

## 2. Bluetooth GATT Architecture

### 2.1 UUID Definitions
All BLE communications take place over the AttendClass custom 128-bit GATT Service:

| Name | UUID | Type | Properties | Description |
|---|---|---|---|---|
| **Primary Attendance Service** | `0000ff10-0000-1000-8000-00805f9b34fb` | Service | N/A | Base offline attendance service |
| **Challenge Characteristic** | `0000ff11-0000-1000-8000-00805f9b34fb` | Characteristic | Read, Notify | Terminal issues time-bound cryptographic challenge |
| **Submission Characteristic** | `0000ff12-0000-1000-8000-00805f9b34fb` | Characteristic | Write, Write Without Response | Phone transmits signed attendance or reconciliation query |
| **Acknowledgement / Receipt** | `0000ff13-0000-1000-8000-00805f9b34fb` | Characteristic | Read, Notify | Terminal issues durable signed receipt |
| **Legacy Time Sync (v2)** | `0000ff01-0000-1000-8000-00805f9b34fb` | Characteristic | Write | Phone-to-terminal provisional clock sync |

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

### 4.2 Terminal Challenge Message
Issued by ESP32 over Characteristic `0000ff11`.

**Payload (JSON)**:
```json
{
  "version": 1,
  "terminal_id": "TERM-LAB1-01",
  "session_id": "sess_20261006",
  "challenge": "<32-byte Base64 TRNG nonce>",
  "terminal_time": 1791298800,
  "time_confidence": "rtc" | "unsynchronized" | "estimated",
  "course_code": "CSC401",
  "signature": "<Terminal ECDSA P-256 Signature Base64>"
}
```

**Canonical String for Challenge Signing**:
```
v1|challenge|{terminal_id}|{session_id}|{challenge}|{terminal_time}|{time_confidence}|{course_code}
```

**Security Rules**:
- Challenge nonces are single-use and expire 60,000 ms (60s) after generation using monotonic elapsed time (`millis()`).
- Signed using the provisioned terminal private key.
- Verified by the mobile app against the institutional `TerminalTrustStore`.

---

### 4.3 Attendance Submission Message
Transmitted by Mobile App over Characteristic `0000ff12`.

**Payload (JSON)**:
```json
{
  "version": 1,
  "event_id": "c1f7b0a8-4e3d-4c8e-9d8a-6b2f4e8a1d2c",
  "credential_id": "cred-p256-01",
  "credential_version": "v1",
  "algorithm": "ECDSA_P256_SHA256",
  "student_id": "std-uuid-001",
  "matric_number": "2021/1/12345CP",
  "terminal_id": "TERM-LAB1-01",
  "session_id": "sess_20261006",
  "challenge": "<32-byte Base64 nonce>",
  "timestamp": 1791298800,
  "timestamp_source": "phone_os",
  "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...",
  "signature": "<Student ECDSA P-256 Signature Base64>"
}
```

**Canonical String for Submission Signing**:
```
v1|submission|{event_id}|{credential_id}|{credential_version}|{algorithm}|{student_id}|{matric_number}|{terminal_id}|{session_id}|{challenge}|{timestamp}|{timestamp_source}
```

**Security Rules**:
- Terminal validates `terminal_id` matches its own identity.
- Terminal validates `challenge` matches an active unexpired challenge nonce.
- Terminal looks up student in cached `/enrolled_keys.csv` and verifies `public_key` matches the authorized public key.
- Terminal verifies the ECDSA signature via mbedtls before recording attendance.

---

### 4.4 Terminal Acknowledgement / Receipt Message
Issued by ESP32 over Characteristic `0000ff13` ONLY after successful SD write and flush.

**Payload (JSON)**:
```json
{
  "version": 1,
  "event_id": "c1f7b0a8-4e3d-4c8e-9d8a-6b2f4e8a1d2c",
  "terminal_id": "TERM-LAB1-01",
  "session_id": "sess_20261006",
  "submission_digest": "<SHA-256 Hex of Canonical Submission>",
  "status": "DURABLY_SAVED",
  "sd_persisted": true,
  "record_index": 142,
  "saved_at": "2026-10-08T09:30:00Z",
  "signature": "<Terminal ECDSA P-256 Signature Base64>",
  "error_code": null
}
```

**Canonical String for Receipt Signing**:
```
v1|receipt|{event_id}|{terminal_id}|{session_id}|{submission_digest}|{status}|{sd_persisted}|{record_index}|{saved_at}
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
