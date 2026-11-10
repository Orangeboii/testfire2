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
