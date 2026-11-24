import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";

const LEASE_MINUTES = 5;
const MAX_BODY_BYTES = 20000;

function token(req) {
  return (/^Bearer[ \t]+(.+)$/i.exec(req.headers.authorization || "") || [])[1] || "";
}
function authorized(req, secret) {
  const a = Buffer.from(token(req));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}
function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Use POST" });
  }
  const secret = process.env.RPA_QUEUE_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "Queue secret is not configured" });
  if (!authorized(req, secret)) return res.status(401).json({ ok: false, error: "Unauthorized" });

  let body;
  try {
    body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) :
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, error: "Body must be valid JSON" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: "JSON object required" });
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: "Payload exceeds 20 KB" });
  }
  if (!process.env.DATABASE_URL) return res.status(500).json({ ok: false, error: "DATABASE_URL is not configured" });

  const sql = neon(process.env.DATABASE_URL);
  try {
    if (body.action === "enqueue") {
      if (!validId(body.run_id)) return res.status(400).json({ ok: false, error: "run_id is required" });
      const rows = await sql`
        INSERT INTO rpa_verification_queue (run_id)
        SELECT run_id FROM rpa_runs WHERE run_id = ${body.run_id}
        ON CONFLICT (run_id) DO NOTHING
        RETURNING job_id, run_id, status
      `;
      if (rows.length) return res.status(201).json({ ok: true, enqueued: true, ...rows[0] });
      const old = await sql`SELECT job_id, run_id, status FROM rpa_verification_queue WHERE run_id = ${body.run_id}`;
      if (old.length) return res.status(200).json({ ok: true, enqueued: false, duplicate: true, ...old[0] });
      return res.status(404).json({ ok: false, error: "Run was not found in rpa_runs" });
    }

    if (body.action === "claim") {
      if (!validId(body.worker_id)) return res.status(400).json({ ok: false, error: "worker_id is required" });
      const jobs = await sql`
        WITH expired AS (
          UPDATE rpa_verification_queue
          SET status='FAILED', locked_by=NULL, lease_until=NULL,
              last_error=COALESCE(last_error, 'Worker lease expired after final attempt'), updated_at=NOW()
          WHERE status='PROCESSING' AND lease_until < NOW() AND attempts >= max_attempts
          RETURNING job_id
        ), candidate AS (
          SELECT job_id FROM rpa_verification_queue
          WHERE attempts < max_attempts AND (status='PENDING' OR (status='PROCESSING' AND lease_until < NOW()))
          ORDER BY created_at, job_id LIMIT 1 FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE rpa_verification_queue q SET status='PROCESSING', attempts=q.attempts+1,
            locked_by=${body.worker_id}, lease_until=NOW()+(${LEASE_MINUTES} * INTERVAL '1 minute'),
            updated_at=NOW(), last_error=NULL
          FROM candidate c WHERE q.job_id=c.job_id
          RETURNING q.job_id, q.run_id, q.attempts, q.max_attempts, q.lease_until
        )
        SELECT c.job_id, c.run_id, c.attempts, c.max_attempts, c.lease_until,
          r.status AS run_status, r.web_rows, r.api_rows, r.api_http_status, r.api_message,
          r.feedback_result, r.started_at, r.finished_at
        FROM claimed c JOIN rpa_runs r ON r.run_id=c.run_id
      `;
      return res.status(200).json({ ok: true, job: jobs[0] || null });
    }

    if (body.action === "complete") {
      if (!validUuid(body.job_id) || !validId(body.run_id) || !validId(body.worker_id))
        return res.status(400).json({ ok: false, error: "job_id, run_id and worker_id are required" });
      if (!["OK", "WARNING", "ERROR"].includes(body.verification_status))
        return res.status(400).json({ ok: false, error: "Invalid verification_status" });
      const details = body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : {};
      const jobs = await sql`
        UPDATE rpa_verification_queue SET status='DONE', verification_status=${body.verification_status},
          verification_details=${JSON.stringify(details)}::jsonb, locked_by=NULL, lease_until=NULL,
          last_error=NULL, updated_at=NOW(), completed_at=NOW()
        WHERE job_id=${body.job_id}::uuid AND run_id=${body.run_id}
          AND status='PROCESSING' AND locked_by=${body.worker_id}
        RETURNING job_id, run_id, status, verification_status, completed_at
      `;
      if (!jobs.length) return res.status(409).json({ ok: false, error: "Job lease is no longer owned by this worker" });
      return res.status(200).json({ ok: true, job: jobs[0] });
    }

    if (body.action === "retry") {
      if (!validUuid(body.job_id) || !validId(body.worker_id))
        return res.status(400).json({ ok: false, error: "job_id and worker_id are required" });
      const reason = typeof body.error === "string" ? body.error.slice(0, 2000) : "Transient worker error";
      const jobs = await sql`
        UPDATE rpa_verification_queue SET status=CASE WHEN attempts>=max_attempts THEN 'FAILED' ELSE 'PENDING' END,
          locked_by=NULL, lease_until=NULL, last_error=${reason}, updated_at=NOW()
        WHERE job_id=${body.job_id}::uuid AND status='PROCESSING' AND locked_by=${body.worker_id}
        RETURNING job_id, run_id, status, attempts, max_attempts, last_error
      `;
      if (!jobs.length) return res.status(409).json({ ok: false, error: "Job lease is no longer owned by this worker" });
      return res.status(200).json({ ok: true, job: jobs[0] });
    }
    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (error) {
    console.error("Verification queue error:", error);
    return res.status(500).json({ ok: false, error: "Could not process queue action" });
  }
}
