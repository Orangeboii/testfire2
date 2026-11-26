import { neon } from "@neondatabase/serverless";
import { createHash, timingSafeEqual } from "node:crypto";

// Email packages include a small, already-validated XLSX as base64.
const MAX_BODY_BYTES = 1_000_000;
const MAX_ATTACHMENT_BASE64 = 900_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const LEASE_MINUTES = 5;

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return match ? match[1] : "";
}

function equalSecret(received, expected) {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") body = JSON.parse(body);
  return body;
}

function isId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Use POST" });
  }

  // A queue-only key keeps the worker computer from reusing the run-write key.
  const expectedSecret = process.env.RPA_QUEUE_SECRET;
  if (!expectedSecret) {
    return res.status(500).json({ ok: false, error: "Queue secret is not configured" });
  }
  if (!equalSecret(bearerToken(req), expectedSecret)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  let body;
  try {
    body = readBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "Body must be valid JSON" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: "JSON object required" });
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: "Payload exceeds 1 MB" });
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return res.status(500).json({ ok: false, error: "DATABASE_URL is not configured" });
  }

  const sql = neon(databaseUrl);
  try {
    if (body.action === "enqueue") {
      if (!isId(body.run_id)) return res.status(400).json({ ok: false, error: "run_id is required" });
      const emailPayload = body.email_payload;
      if (!emailPayload || typeof emailPayload !== "object" || Array.isArray(emailPayload)) {
        return res.status(400).json({ ok: false, error: "email_payload is required" });
      }
      if (emailPayload.schema !== "rpa-email-v1" || emailPayload.run_id !== body.run_id ||
          typeof emailPayload.recipient !== "string" || typeof emailPayload.subject !== "string" ||
          typeof emailPayload.body_text !== "string" || !emailPayload.verification ||
          typeof emailPayload.verification !== "object") {
        return res.status(400).json({ ok: false, error: "email_payload is incomplete or does not match run_id" });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPayload.recipient) ||
          emailPayload.subject.length > 240 || /[\r\n]/.test(emailPayload.subject) ||
          emailPayload.body_text.length > 30_000) {
        return res.status(400).json({ ok: false, error: "email recipient, subject or body is invalid" });
      }
      if (emailPayload.attachment !== null && emailPayload.attachment !== undefined) {
        const attachment = emailPayload.attachment;
        if (!attachment || typeof attachment !== "object" ||
            typeof attachment.filename !== "string" ||
            attachment.filename !== "transacciones.xlsx" ||
            attachment.mime_type !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
            typeof attachment.content_base64 !== "string" ||
            attachment.content_base64.length > MAX_ATTACHMENT_BASE64 ||
            typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(attachment.sha256) ||
            !Number.isSafeInteger(attachment.size_bytes) || attachment.size_bytes < 1) {
          return res.status(400).json({ ok: false, error: "email attachment is invalid or exceeds the limit" });
        }
        const bytes = Buffer.from(attachment.content_base64, "base64");
        const canonicalBase64 = bytes.toString("base64");
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (canonicalBase64 !== attachment.content_base64 || bytes.length !== attachment.size_bytes ||
            digest.toLowerCase() !== attachment.sha256.toLowerCase()) {
          return res.status(400).json({ ok: false, error: "email attachment integrity check failed" });
        }
      }

      const rows = await sql`
        INSERT INTO rpa_verification_queue (run_id, email_payload)
        SELECT run_id, ${JSON.stringify(emailPayload)}::jsonb
        FROM rpa_runs WHERE run_id = ${body.run_id}
        ON CONFLICT (run_id) DO UPDATE
        SET email_payload = EXCLUDED.email_payload,
            updated_at = NOW()
        WHERE rpa_verification_queue.status = 'PENDING'
          AND rpa_verification_queue.attempts = 0
          AND rpa_verification_queue.email_payload = '{}'::jsonb
        RETURNING job_id, run_id, status, email_payload <> '{}'::jsonb AS mail_payload_saved
      `;
      if (rows.length) {
        return res.status(201).json({ ok: true, enqueued: true, ...rows[0] });
      }

      const existing = await sql`
        SELECT job_id, run_id, status,
               email_payload <> '{}'::jsonb AS mail_payload_saved
        FROM rpa_verification_queue WHERE run_id = ${body.run_id}
      `;
      if (existing.length) {
        return res.status(200).json({ ok: true, enqueued: false, duplicate: true, ...existing[0] });
      }
      return res.status(404).json({ ok: false, error: "Run was not found in rpa_runs" });
    }


    if (body.action === "approval_capabilities") {
      const rows = await sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rpa_approvals' AND column_name = 'flow_version') AS enabled`;
      return res.status(200).json({ ok: true, version: 2, enabled: rows[0].enabled });
    }


    if (body.action === "approval_ready") {
      if (!isUuid(body.job_id) || !isUuid(body.run_id) || !isId(body.worker_id) ||
          !Number.isSafeInteger(body.attempt) || body.attempt < 1) {
        return res.status(400).json({ ok: false, error: "Invalid ready request" });
      }
      const messageId = "<rpa." + body.run_id + "@mantistcy.cl>";
      const rows = await sql`
        WITH owned AS (
          SELECT run_id FROM rpa_verification_queue
          WHERE job_id = ${body.job_id}::uuid AND run_id = ${body.run_id}
            AND status = 'PROCESSING' AND locked_by = ${body.worker_id}
            AND attempts = ${body.attempt} AND lease_until > NOW()
            AND email_payload #> '{approval,required}' = 'true'::jsonb
          FOR UPDATE
        ), ready AS (
          INSERT INTO rpa_approvals (run_id, dispatch_status, worker_id, outbound_message_id, send_started_at, flow_version)
          SELECT run_id, 'READY', ${body.worker_id}, ${messageId}, NULL, 2 FROM owned
          ON CONFLICT DO NOTHING RETURNING run_id
        )
        UPDATE rpa_verification_queue q
        SET status = 'PENDING', locked_by = NULL, lease_until = NULL,
            verification_status = ${body.warning === true ? "WARNING" : "OK"},
            verification_details = '{"approval_status":"PENDING","ready_for_approval":true,"email_sent":false}'::jsonb,
            updated_at = NOW()
        FROM ready WHERE q.run_id = ready.run_id RETURNING q.run_id
      `;
      if (!rows.length) return res.status(409).json({ ok: false, error: "Job not ready" });
      return res.status(200).json({ ok: true });
    }

    if (body.action === "approval_next") {
      if (!isId(body.worker_id)) return res.status(400).json({ ok: false, error: "worker_id is required" });
      const rows = await sql`
        SELECT q.job_id, q.run_id, ${body.worker_id}::text AS worker_id,
               q.email_payload, a.outbound_message_id, r.status AS run_status, r.web_rows, r.api_rows,
               r.api_http_status, r.api_message, r.feedback_result
        FROM rpa_approvals a JOIN rpa_verification_queue q USING (run_id)
        JOIN rpa_runs r USING (run_id)
        WHERE a.flow_version = 2 AND a.dispatch_status = 'READY' AND a.decision = 'APPROVED'
          AND q.status = 'PENDING'
        ORDER BY a.decided_at, q.job_id LIMIT 1
      `;
      return res.status(200).json({ ok: true, job: rows[0] || null });
    }

    if (body.action === "approval_hold") {
      if (!isUuid(body.job_id) || !isUuid(body.run_id) || !isId(body.worker_id)) {
        return res.status(400).json({ ok: false, error: "Invalid hold request" });
      }
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : "El paquete cambió después de la aprobación.";
      const rows = await sql`
        WITH owned AS (
          SELECT run_id FROM rpa_verification_queue
          WHERE job_id = ${body.job_id}::uuid AND run_id = ${body.run_id} AND status = 'PENDING'
          FOR UPDATE
        ), blocked AS (
          UPDATE rpa_approvals a SET dispatch_status = 'BLOCKED'
          FROM owned WHERE a.run_id = owned.run_id AND a.flow_version = 2
            AND a.dispatch_status = 'READY' AND a.decision = 'APPROVED'
          RETURNING a.run_id
        )
        UPDATE rpa_verification_queue q
        SET status = 'REVIEW', verification_status = 'ERROR', last_error = ${reason},
            verification_details = jsonb_build_object('email_sent', false, 'errors', jsonb_build_array(${reason}::text)),
            completed_at = NOW(), updated_at = NOW()
        FROM blocked WHERE q.run_id = blocked.run_id RETURNING q.run_id
      `;
      if (!rows.length) return res.status(409).json({ ok: false, error: "Hold not granted" });
      return res.status(200).json({ ok: true });
    }

    if (body.action === "approval_begin") {
      if (!isUuid(body.job_id) || !isUuid(body.run_id) || !isId(body.worker_id)) {
        return res.status(400).json({ ok: false, error: "Invalid reservation" });
      }
      const rows = await sql`
        WITH owned AS (
          SELECT run_id FROM rpa_verification_queue
          WHERE job_id = ${body.job_id}::uuid AND run_id = ${body.run_id}
            AND status = 'PENDING'
          FOR UPDATE
        ), reserved AS (
          UPDATE rpa_approvals a
          SET dispatch_status = 'SENDING', worker_id = ${body.worker_id}, send_started_at = NOW()
          FROM owned WHERE a.run_id = owned.run_id AND a.flow_version = 2
            AND a.dispatch_status = 'READY' AND a.decision = 'APPROVED'
          RETURNING a.run_id, a.outbound_message_id
        )
        UPDATE rpa_verification_queue q
        SET status = 'PROCESSING', locked_by = ${body.worker_id},
            lease_until = NOW() + (${LEASE_MINUTES} * INTERVAL '1 minute'), updated_at = NOW()
        FROM reserved WHERE q.run_id = reserved.run_id RETURNING reserved.outbound_message_id
      `;
      if (!rows.length) return res.status(409).json({ ok: false, error: "Reservation not granted" });
      return res.status(200).json({ ok: true, outbound_message_id: rows[0].outbound_message_id });
    }

    if (body.action === "approval_finish") {
      if (!isUuid(body.job_id) || !isId(body.run_id) || !isId(body.worker_id) ||
          typeof body.smtp_accepted !== "boolean") {
        return res.status(400).json({ ok: false, error: "Invalid completion" });
      }
      const accepted = body.smtp_accepted;
      const rows = await sql`
        WITH owned AS (
          SELECT run_id FROM rpa_verification_queue
          WHERE job_id = ${body.job_id}::uuid AND run_id = ${body.run_id}
            AND status = 'PROCESSING' AND locked_by = ${body.worker_id}
          FOR UPDATE
        ), recorded AS (
          UPDATE rpa_approvals a
          SET dispatch_status = ${accepted ? "SENT" : "UNCERTAIN"},
              sent_at = CASE WHEN ${accepted} THEN NOW() ELSE NULL END
          FROM owned WHERE a.run_id = owned.run_id AND a.worker_id = ${body.worker_id}
            AND a.dispatch_status = 'SENDING' AND (a.flow_version = 1 OR a.decision = 'APPROVED')
          RETURNING a.run_id, a.decision
        )
        UPDATE rpa_verification_queue q
        SET status = ${accepted ? "DONE" : "REVIEW"},
            verification_status = ${accepted ? (body.warning === true ? "WARNING" : "OK") : "ERROR"},
            verification_details = jsonb_build_object('email_sent', CASE WHEN ${accepted}::boolean THEN TRUE ELSE NULL END,
              'approval_status', recorded.decision, 'dispatch_status', ${accepted ? "SENT" : "UNCERTAIN"}::text),
            last_error = ${accepted ? null : "Envío incierto; revisar manualmente sin reenviar."},
            locked_by = NULL, lease_until = NULL, completed_at = NOW(), updated_at = NOW()
        FROM recorded WHERE q.run_id = recorded.run_id RETURNING q.run_id
      `;
      if (!rows.length) return res.status(409).json({ ok: false, error: "Reservation not active" });
      return res.status(200).json({ ok: true });
    }

    if (body.action === "approval_lookup") {
      if (!isId(body.run_id)) return res.status(400).json({ ok: false, error: "Invalid run_id" });
      const rows = await sql`
        SELECT run_id, dispatch_status, decision, outbound_message_id, inbound_message_id, flow_version
        FROM rpa_approvals WHERE run_id = ${body.run_id}
      `;
      return res.status(200).json({ ok: true, approval: rows[0] || null });
    }

    if (body.action === "approval_decide") {
      const supervisor = "nico.cuevasl@duocuc.cl";
      const id = body.inbound_message_id;
      if (!isId(body.run_id) || body.sender !== supervisor ||
          !["APPROVED", "REJECTED"].includes(body.approval_decision) ||
          body.outbound_message_id?.length > 240 || !isId(body.outbound_message_id) ||
          typeof id !== "string" || id.length > 512 || !/^<[^<>\s]+>$/.test(id)) {
        return res.status(400).json({ ok: false, error: "Invalid supervisor decision" });
      }
      const rows = await sql`
        WITH owned AS (
          SELECT run_id FROM rpa_verification_queue WHERE run_id = ${body.run_id} FOR UPDATE
        ), decided AS (
          UPDATE rpa_approvals a
          SET decision = ${body.approval_decision}, decided_at = NOW(),
              decided_by = ${supervisor}, inbound_message_id = ${id}
          FROM owned
          WHERE a.run_id = owned.run_id AND a.outbound_message_id = ${body.outbound_message_id}
            AND ((a.flow_version = 2 AND a.dispatch_status = 'READY') OR
                 (a.flow_version = 1 AND a.dispatch_status = 'SENT'))
            AND a.decision = 'PENDING'
            AND NOT EXISTS (SELECT 1 FROM rpa_approvals previous WHERE previous.inbound_message_id = ${id})
          RETURNING a.run_id, a.decision, a.decided_at, a.flow_version
        )
        UPDATE rpa_verification_queue q
        SET status = CASE WHEN decided.flow_version = 2 AND decided.decision = 'REJECTED' THEN 'DONE' ELSE q.status END,
            completed_at = CASE WHEN decided.flow_version = 2 AND decided.decision = 'REJECTED' THEN NOW() ELSE q.completed_at END,
            verification_details = q.verification_details || jsonb_build_object('approval_status', decided.decision),
            updated_at = NOW()
        FROM decided WHERE q.run_id = decided.run_id
        RETURNING decided.run_id, decided.decision, decided.decided_at
      `;
      if (rows.length) return res.status(200).json({ ok: true, approval: rows[0] });
      const existing = await sql`
        SELECT run_id, decision, decided_at FROM rpa_approvals
        WHERE run_id = ${body.run_id} AND inbound_message_id = ${id}
          AND decision = ${body.approval_decision}
      `;
      if (existing.length) return res.status(200).json({ ok: true, duplicate: true, approval: existing[0] });
      return res.status(409).json({ ok: false, error: "Decision not accepted" });
    }

    if (body.action === "claim") {
      if (!isId(body.worker_id)) return res.status(400).json({ ok: false, error: "worker_id is required" });


      if (body.approval_only === true) {
        await sql`
          WITH stale AS (
            SELECT q.run_id FROM rpa_verification_queue q
            JOIN rpa_approvals a ON a.run_id = q.run_id
            WHERE q.status = 'PROCESSING' AND q.lease_until < NOW() AND a.dispatch_status = 'SENDING'
            FOR UPDATE OF q SKIP LOCKED
          ), uncertain AS (
            UPDATE rpa_approvals a SET dispatch_status = 'UNCERTAIN'
            FROM stale WHERE a.run_id = stale.run_id AND a.dispatch_status = 'SENDING'
            RETURNING a.run_id
          )
          UPDATE rpa_verification_queue q SET status = 'REVIEW', verification_status = 'ERROR',
            last_error = 'Resultado SMTP incierto. Revisar Enviados antes de repetir.',
            verification_details = q.verification_details || '{"email_sent":null,"dispatch_status":"UNCERTAIN"}'::jsonb,
            locked_by = NULL, lease_until = NULL, completed_at = NOW(), updated_at = NOW()
          FROM uncertain WHERE q.run_id = uncertain.run_id
        `;
      }

      // One atomic statement leases a single job. An expired lease makes a job
      // available again if a worker computer stops unexpectedly.
      const rows = await sql`
        WITH expired AS (
          UPDATE rpa_verification_queue
          SET status = 'FAILED', locked_by = NULL, lease_until = NULL,
              last_error = COALESCE(last_error, 'Worker lease expired after the final attempt'),
              updated_at = NOW()
          WHERE status = 'PROCESSING' AND lease_until < NOW() AND attempts >= max_attempts
            AND (email_payload ? 'approval') = ${body.approval_only === true}
            AND NOT EXISTS (SELECT 1 FROM rpa_approvals a WHERE a.run_id = rpa_verification_queue.run_id)
          RETURNING job_id
        ), candidate AS (
          SELECT q.job_id
          FROM rpa_verification_queue q
          WHERE q.attempts < q.max_attempts
            AND (q.email_payload ? 'approval') = ${body.approval_only === true}
            AND NOT EXISTS (SELECT 1 FROM rpa_approvals a WHERE a.run_id = q.run_id)
            AND (q.status = 'PENDING' OR (q.status = 'PROCESSING' AND q.lease_until < NOW()))
          ORDER BY q.created_at, q.job_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE rpa_verification_queue q
          SET status = 'PROCESSING',
              attempts = q.attempts + 1,
              locked_by = ${body.worker_id},
              lease_until = NOW() + (${LEASE_MINUTES} * INTERVAL '1 minute'),
              updated_at = NOW(),
              last_error = NULL
          FROM candidate c
          WHERE q.job_id = c.job_id
          RETURNING q.job_id, q.run_id, q.attempts, q.max_attempts, q.lease_until
        )
        SELECT c.job_id, c.run_id, c.attempts, c.max_attempts, c.lease_until,
               ${body.worker_id}::text AS worker_id,
               q.email_payload,
               r.status AS run_status, r.web_rows, r.api_rows,
               r.api_http_status, r.api_message, r.feedback_result,
               r.web_transactions, r.api_transactions,
               r.started_at, r.finished_at
        FROM claimed c
        JOIN rpa_verification_queue q ON q.job_id = c.job_id
        JOIN rpa_runs r ON r.run_id = c.run_id
      `;
      if (!rows.length) return res.status(200).json({ ok: true, job: null });
      return res.status(200).json({ ok: true, job: rows[0] });
    }

    if (body.action === "complete") {
      if (!isUuid(body.job_id) || !isId(body.run_id) || !isId(body.worker_id)) {
        return res.status(400).json({ ok: false, error: "job_id, run_id and worker_id are required" });
      }
      if (!["OK", "WARNING", "ERROR"].includes(body.verification_status)) {
        return res.status(400).json({ ok: false, error: "verification_status must be OK, WARNING or ERROR" });
      }
      if (!["SENT", "REVIEW"].includes(body.decision)) {
        return res.status(400).json({ ok: false, error: "decision must be SENT or REVIEW" });
      }
      const details = body.details && typeof body.details === "object" && !Array.isArray(body.details)
        ? body.details : {};
      if (body.decision === "SENT" &&
          (body.verification_status !== "OK" || details.email_sent !== true || details.verified_run_id !== body.run_id)) {
        return res.status(400).json({ ok: false, error: "SENT requires a passing verification and confirmed email send" });
      }
      if (body.decision === "REVIEW" && body.verification_status === "OK") {
        return res.status(400).json({ ok: false, error: "REVIEW cannot have verification_status OK" });
      }
      const rows = await sql`
        UPDATE rpa_verification_queue
        SET status = ${body.decision === "SENT" ? "DONE" : "REVIEW"},
            verification_status = ${body.verification_status},
            verification_details = ${JSON.stringify(details)}::jsonb,
            locked_by = NULL, lease_until = NULL, last_error = NULL,
            updated_at = NOW(), completed_at = NOW()
        WHERE job_id = ${body.job_id}::uuid
          AND run_id = ${body.run_id}
          AND status = 'PROCESSING'
          AND locked_by = ${body.worker_id}
          AND NOT EXISTS (SELECT 1 FROM rpa_approvals a WHERE a.run_id = rpa_verification_queue.run_id)
          AND NOT (${body.decision === "SENT"} AND email_payload ? 'approval')
        RETURNING job_id, run_id, status, verification_status, completed_at
      `;
      if (!rows.length) return res.status(409).json({ ok: false, error: "Job lease is no longer owned by this worker" });
      return res.status(200).json({ ok: true, job: rows[0] });
    }

    if (body.action === "retry") {
      if (!isUuid(body.job_id) || !isId(body.worker_id)) {
        return res.status(400).json({ ok: false, error: "job_id and worker_id are required" });
      }
      const reason = typeof body.error === "string" ? body.error.slice(0, 2000) : "Transient worker error";
      const rows = await sql`
        UPDATE rpa_verification_queue
        SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'PENDING' END,
            locked_by = NULL, lease_until = NULL, last_error = ${reason}, updated_at = NOW()
        WHERE job_id = ${body.job_id}::uuid
          AND status = 'PROCESSING'
          AND locked_by = ${body.worker_id}
          AND NOT EXISTS (SELECT 1 FROM rpa_approvals a WHERE a.run_id = rpa_verification_queue.run_id)
        RETURNING job_id, run_id, status, attempts, max_attempts, last_error
      `;
      if (!rows.length) return res.status(409).json({ ok: false, error: "Job lease is no longer owned by this worker" });
      return res.status(200).json({ ok: true, job: rows[0] });
    }

    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (error) {
    console.error("Verification queue error:", error);
    return res.status(500).json({ ok: false, error: "Could not process queue action" });
  }
}
