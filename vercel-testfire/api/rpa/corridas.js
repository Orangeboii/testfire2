import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 1_000_000;

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
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

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Use POST" });
  }

  const expectedSecret = process.env.RPA_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return res.status(500).json({ ok: false, error: "Webhook secret is not configured" });
  }
  if (!equalSecret(bearerToken(req), expectedSecret)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  let payload;
  try {
    payload = readBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "Body must be valid JSON" });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return res.status(400).json({ ok: false, error: "JSON object required" });
  }

  let bodySize;
  try {
    bodySize = Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON payload" });
  }
  if (bodySize > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: "Payload exceeds 1 MB" });
  }

  const webTransactions = payload.web_transactions ?? [];
  const apiTransactions = payload.api_transactions ?? [];
  if (!Array.isArray(webTransactions) || !Array.isArray(apiTransactions)) {
    return res.status(400).json({ ok: false, error: "Transaction fields must be arrays" });
  }
  if (!payload.run_id || typeof payload.run_id !== "string") {
    return res.status(400).json({ ok: false, error: "run_id is required" });
  }
  if (!isNonNegativeInteger(payload.web_rows) || !isNonNegativeInteger(payload.api_rows)) {
    return res.status(400).json({ ok: false, error: "web_rows and api_rows must be nonnegative integers" });
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return res.status(500).json({ ok: false, error: "DATABASE_URL is not configured" });
  }

  try {
    const sql = neon(databaseUrl);
    const rows = await sql`
      INSERT INTO rpa_runs (
        run_id, event_name, user_name, device_name, started_at, finished_at,
        status, web_rows, api_rows, api_http_status, api_message,
        feedback_result, web_transactions, api_transactions, raw_payload
      ) VALUES (
        ${payload.run_id}, ${payload.event ?? "rpa.run.completed"},
        ${payload.user ?? null}, ${payload.device ?? null},
        ${payload.started_at ?? null}, ${payload.finished_at ?? null},
        ${payload.status ?? "UNKNOWN"}, ${payload.web_rows}, ${payload.api_rows},
        ${String(payload.api_http_status ?? "")},
        ${String(payload.api_message ?? "")}, ${String(payload.feedback_result ?? "")},
        ${JSON.stringify(webTransactions)}::jsonb,
        ${JSON.stringify(apiTransactions)}::jsonb,
        ${JSON.stringify(payload)}::jsonb
      )
      ON CONFLICT (run_id) DO UPDATE SET
        event_name = EXCLUDED.event_name,
        user_name = EXCLUDED.user_name,
        device_name = EXCLUDED.device_name,
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at,
        status = EXCLUDED.status,
        web_rows = EXCLUDED.web_rows,
        api_rows = EXCLUDED.api_rows,
        api_http_status = EXCLUDED.api_http_status,
        api_message = EXCLUDED.api_message,
        feedback_result = EXCLUDED.feedback_result,
        web_transactions = EXCLUDED.web_transactions,
        api_transactions = EXCLUDED.api_transactions,
        raw_payload = EXCLUDED.raw_payload
      RETURNING run_id
    `;

    return res.status(201).json({
      ok: true,
      saved: true,
      run_id: rows[0].run_id,
      web_rows: webTransactions.length,
      api_rows: apiTransactions.length
    });
  } catch (error) {
    console.error("Vercel webhook database error:", error);
    return res.status(500).json({ ok: false, error: "Could not save the run" });
  }
}
