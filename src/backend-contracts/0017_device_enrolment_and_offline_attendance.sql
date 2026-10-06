-- =============================================================================
-- 0017: Admin-Approved Device Enrolment and Offline Signed Attendance
-- =============================================================================
SET search_path TO public, extensions;

-- ── 1. Create table for device activation codes ─────────────────────────────
CREATE TABLE IF NOT EXISTS device_activation_codes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  code_hash     text        NOT NULL,
  purpose       text        NOT NULL DEFAULT 'device_enrollment',
  attempts      integer     NOT NULL DEFAULT 0,
  max_attempts  integer     NOT NULL DEFAULT 3,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_by    uuid        REFERENCES profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE device_activation_codes IS 'One-time, short-lived activation codes for student phone enrolment.';
COMMENT ON COLUMN device_activation_codes.code_hash IS 'SHA-256 digest of uppercase plaintext code; plaintext is never stored.';

CREATE INDEX IF NOT EXISTS idx_device_activation_student ON device_activation_codes(student_id);
CREATE INDEX IF NOT EXISTS idx_device_activation_hash ON device_activation_codes(code_hash);

ALTER TABLE device_activation_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY device_activation_codes_admin_all ON device_activation_codes FOR ALL USING (true) WITH CHECK (true);

-- ── 2. Add extra columns to student_devices ─────────────────────────────────
ALTER TABLE student_devices ADD COLUMN IF NOT EXISTS device_name text;
ALTER TABLE student_devices ADD COLUMN IF NOT EXISTS device_fingerprint text;
ALTER TABLE student_devices ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE student_devices ADD COLUMN IF NOT EXISTS revocation_reason text;
ALTER TABLE student_devices ADD COLUMN IF NOT EXISTS algorithm text NOT NULL DEFAULT 'ECDSA_P256_SHA256';
ALTER TABLE student_devices ADD COLUMN IF NOT EXISTS credential_id text;
ALTER TABLE student_devices ADD COLUMN IF NOT EXISTS credential_version text DEFAULT 'v1';

CREATE INDEX IF NOT EXISTS idx_student_devices_student_active ON student_devices(student_id) WHERE revoked_at IS NULL;

-- ── 3. Add offline and idempotency columns to attendance_logs ───────────────
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS event_id uuid UNIQUE;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS terminal_id text;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS terminal_saved_at timestamptz;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS phone_attendance_time timestamptz;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS timestamp_source text DEFAULT 'phone_os';
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS terminal_receipt_sig text;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS submission_digest text;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS offline_verified boolean DEFAULT false;

-- ── 4. Helper function to generate random alphanumeric code ─────────────────
CREATE OR REPLACE FUNCTION generate_activation_code()
RETURNS text AS $$
DECLARE
  chars text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; -- Exclude 0, 1, I, O for readability
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ── 5. Admin RPC: Generate Activation Code ──────────────────────────────────
CREATE OR REPLACE FUNCTION admin_generate_device_activation_code(
  p_admin_token uuid,
  p_student_id uuid,
  p_expiry_minutes integer DEFAULT 60
)
RETURNS jsonb AS $$
DECLARE
  _admin profiles%ROWTYPE;
  _sess active_sessions%ROWTYPE;
  _raw_code text;
  _code_hash text;
  _expires_at timestamptz;
  _record_id uuid;
BEGIN
  -- Verify admin session
  SELECT * INTO _sess FROM active_sessions WHERE token = p_admin_token AND expires_at > now();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unauthorized: invalid or expired session');
  END IF;

  SELECT * INTO _admin FROM profiles WHERE id = _sess.account_id;
  IF _admin.role NOT IN ('administrator', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Permission denied: administrator or manager role required');
  END IF;

  -- Ensure target student exists
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_student_id AND role = 'user') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Student not found');
  END IF;

  -- Expire any previous unconsumed codes for this student
  UPDATE device_activation_codes
  SET consumed_at = now()
  WHERE student_id = p_student_id AND consumed_at IS NULL;

  -- Generate code
  _raw_code := generate_activation_code();
  _code_hash := encode(digest(_raw_code, 'sha256'), 'hex');
  _expires_at := now() + (COALESCE(p_expiry_minutes, 60) || ' minutes')::interval;

  INSERT INTO device_activation_codes (
    student_id,
    code_hash,
    purpose,
    max_attempts,
    expires_at,
    created_by
  ) VALUES (
    p_student_id,
    _code_hash,
    'device_enrollment',
    3,
    _expires_at,
    _admin.id
  ) RETURNING id INTO _record_id;

  RETURN jsonb_build_object(
    'ok', true,
    'activation_code', _raw_code,
    'expires_at', _expires_at,
    'student_id', p_student_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 6. Student RPC: Enroll / Bind Device ─────────────────────────────────────
CREATE OR REPLACE FUNCTION platform_enroll_device(
  p_token uuid,
  p_activation_code text,
  p_device_public_key text,
  p_platform text,
  p_device_name text DEFAULT 'Mobile Device',
  p_algorithm text DEFAULT 'ECDSA_P256_SHA256',
  p_credential_id text DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  _sess active_sessions%ROWTYPE;
  _student profiles%ROWTYPE;
  _code_record device_activation_codes%ROWTYPE;
  _incoming_hash text;
  _new_device_id uuid;
BEGIN
  -- Verify student session
  SELECT * INTO _sess FROM active_sessions WHERE token = p_token AND expires_at > now();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Session expired or invalid');
  END IF;

  SELECT * INTO _student FROM profiles WHERE id = _sess.account_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Account not found');
  END IF;

  IF p_activation_code IS NULL OR length(trim(p_activation_code)) != 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid activation code format (expected 8 alphanumeric characters)');
  END IF;

  IF p_device_public_key IS NULL OR length(trim(p_device_public_key)) < 64 OR length(trim(p_device_public_key)) > 512 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid device public key length');
  END IF;

  _incoming_hash := encode(digest(upper(trim(p_activation_code)), 'sha256'), 'hex');

  -- Lock activation code row atomically
  SELECT * INTO _code_record
  FROM device_activation_codes
  WHERE student_id = _student.id
    AND consumed_at IS NULL
    AND expires_at > now()
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No active activation code found. Please request a new code from an administrator.');
  END IF;

  IF _code_record.attempts >= _code_record.max_attempts THEN
    UPDATE device_activation_codes SET consumed_at = now() WHERE id = _code_record.id;
    RETURN jsonb_build_object('ok', false, 'error', 'Maximum activation attempts exceeded. Code has been invalidated.');
  END IF;

  IF _code_record.code_hash != _incoming_hash THEN
    UPDATE device_activation_codes
    SET attempts = attempts + 1
    WHERE id = _code_record.id;

    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Invalid activation code. Attempts remaining: ' || (_code_record.max_attempts - _code_record.attempts - 1)
    );
  END IF;

  -- Mark code consumed atomically
  UPDATE device_activation_codes
  SET consumed_at = now()
  WHERE id = _code_record.id;

  -- Revoke any previously active device for this student (Device Replacement Policy)
  UPDATE student_devices
  SET revoked_at = now(),
      revocation_reason = 'replaced_by_new_enrolment'
  WHERE student_id = _student.id
    AND revoked_at IS NULL;

  -- Invalidate all other active sessions for this student on other devices
  DELETE FROM active_sessions
  WHERE account_id = _student.id
    AND token != p_token;

  -- Register new authorized device with verified algorithm and credential metadata
  INSERT INTO student_devices (
    student_id,
    device_public_key,
    algorithm,
    credential_id,
    credential_version,
    platform,
    device_name,
    enrolled_at
  ) VALUES (
    _student.id,
    p_device_public_key,
    COALESCE(p_algorithm, 'ECDSA_P256_SHA256'),
    COALESCE(p_credential_id, encode(digest(p_device_public_key, 'sha256'), 'hex')),
    'v1',
    COALESCE(p_platform, 'android'),
    COALESCE(p_device_name, 'Mobile Device'),
    now()
  ) RETURNING id INTO _new_device_id;

  RETURN jsonb_build_object(
    'ok', true,
    'device_id', _new_device_id,
    'student_id', _student.id,
    'matric_number', _student.matric_number,
    'full_name', _student.full_name,
    'enrolled_at', now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 7. Check Active Device Enrolment RPC ─────────────────────────────────────
CREATE OR REPLACE FUNCTION platform_get_device_status(p_token uuid)
RETURNS jsonb AS $$
DECLARE
  _sess active_sessions%ROWTYPE;
  _dev student_devices%ROWTYPE;
BEGIN
  SELECT * INTO _sess FROM active_sessions WHERE token = p_token AND expires_at > now();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Session expired or invalid');
  END IF;

  SELECT * INTO _dev
  FROM student_devices
  WHERE student_id = _sess.account_id
    AND revoked_at IS NULL
  ORDER BY enrolled_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'enrolled', false,
      'device', null
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'enrolled', true,
    'device', jsonb_build_object(
      'id', _dev.id,
      'device_public_key', _dev.device_public_key,
      'platform', _dev.platform,
      'device_name', _dev.device_name,
      'enrolled_at', _dev.enrolled_at
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 8. Admin RPC: Revoke Device ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_revoke_device(
  p_admin_token uuid,
  p_device_id uuid,
  p_reason text DEFAULT 'Admin revoked'
)
RETURNS jsonb AS $$
DECLARE
  _admin profiles%ROWTYPE;
  _sess active_sessions%ROWTYPE;
  _dev student_devices%ROWTYPE;
BEGIN
  SELECT * INTO _sess FROM active_sessions WHERE token = p_admin_token AND expires_at > now();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unauthorized');
  END IF;

  SELECT * INTO _admin FROM profiles WHERE id = _sess.account_id;
  IF _admin.role NOT IN ('administrator', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Permission denied');
  END IF;

  SELECT * INTO _dev FROM student_devices WHERE id = p_device_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Device not found');
  END IF;

  UPDATE student_devices
  SET revoked_at = now(),
      revocation_reason = COALESCE(p_reason, 'Admin revoked')
  WHERE id = p_device_id;

  -- Invalidate all active sessions for the target student
  DELETE FROM active_sessions WHERE account_id = _dev.student_id;

  RETURN jsonb_build_object(
    'ok', true,
    'device_id', p_device_id,
    'revoked_at', now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
