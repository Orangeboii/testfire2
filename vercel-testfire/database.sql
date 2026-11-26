CREATE TABLE IF NOT EXISTS rpa_runs (
  run_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL DEFAULT 'rpa.run.completed',
  user_name TEXT,
  device_name TEXT,
  started_at TEXT,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  web_rows INTEGER NOT NULL DEFAULT 0,
  api_rows INTEGER NOT NULL DEFAULT 0,
  api_http_status TEXT,
  api_message TEXT,
  feedback_result TEXT,
  web_transactions JSONB NOT NULL DEFAULT '[]'::jsonb,
  api_transactions JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpa_runs_finished_at ON rpa_runs (finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_rpa_runs_status ON rpa_runs (status);

-- Cola compartida para que un robot verificador, incluso en otro computador,
-- procese cada corrida una sola vez. La cola referencia la corrida ya guardada.
CREATE TABLE IF NOT EXISTS rpa_verification_queue (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL UNIQUE REFERENCES rpa_runs(run_id) ON DELETE CASCADE,
  email_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'REVIEW')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_by TEXT,
  lease_until TIMESTAMPTZ,
  verification_status TEXT
    CHECK (verification_status IS NULL OR verification_status IN ('OK', 'WARNING', 'ERROR')),
  verification_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Migración segura para instalaciones que ya tenían creada la cola.
ALTER TABLE rpa_verification_queue
  ADD COLUMN IF NOT EXISTS email_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE rpa_verification_queue
  DROP CONSTRAINT IF EXISTS rpa_verification_queue_status_check;
ALTER TABLE rpa_verification_queue
  ADD CONSTRAINT rpa_verification_queue_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'REVIEW'));

CREATE INDEX IF NOT EXISTS idx_rpa_verification_queue_pending
  ON rpa_verification_queue (created_at)
  WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_rpa_verification_queue_lease
  ON rpa_verification_queue (lease_until)
  WHERE status = 'PROCESSING';

CREATE TABLE IF NOT EXISTS rpa_approvals (
  run_id TEXT PRIMARY KEY REFERENCES rpa_verification_queue(run_id) ON DELETE RESTRICT,
  dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('SENDING', 'SENT', 'UNCERTAIN')),
  decision TEXT NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING', 'APPROVED', 'REJECTED')),
  worker_id TEXT NOT NULL,
  outbound_message_id TEXT NOT NULL UNIQUE,
  send_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  decided_by TEXT,
  inbound_message_id TEXT UNIQUE
);

DO $migration$
BEGIN
  ALTER TABLE rpa_approvals ADD COLUMN IF NOT EXISTS flow_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE rpa_approvals ALTER COLUMN send_started_at DROP NOT NULL;
  ALTER TABLE rpa_approvals DROP CONSTRAINT IF EXISTS rpa_approvals_dispatch_status_check;
  ALTER TABLE rpa_approvals ADD CONSTRAINT rpa_approvals_dispatch_status_check
    CHECK (dispatch_status IN ('READY', 'SENDING', 'SENT', 'UNCERTAIN', 'BLOCKED'));
  ALTER TABLE rpa_approvals DROP CONSTRAINT IF EXISTS rpa_approvals_send_after_decision_check;
  ALTER TABLE rpa_approvals ADD CONSTRAINT rpa_approvals_send_after_decision_check
    CHECK (flow_version = 1 OR dispatch_status NOT IN ('SENDING','SENT','UNCERTAIN') OR decision = 'APPROVED');
END
$migration$;
