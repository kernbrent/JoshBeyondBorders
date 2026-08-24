import { parseDistributionMessage, type CsmDistributionMessage } from "./csm-distribution-contract";
import { fetchRepositoryWorkbook, verifyDataKey } from "./workbook-repository";
import { HttpError, isObject, jsonResponse, parseJsonRequest, requireAllowedOrigin } from "./shared";

type CsmEnv = Env & { DB: D1Database; CSM_DISTRIBUTION_SECRET?: string; CSM_STATUS?: Fetcher };
type InboxStatus = "pending" | "needs_match" | "approved" | "denied" | "failed";
type InboxRow = {
  id: string; idempotency_key: string; payload_json: string; status: InboxStatus;
  matched_donor_id: string | null; match_method: string | null;
  recipient_record_id: string | null; callback_status: string; decision_reason: string | null;
};
type DonorRow = { id: string; display_name: string; first_name: string | null; last_name: string | null; email: string | null };

const cleanLine = (value: unknown, maximum: number): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return cleaned && cleaned.length <= maximum && !/[\u0000-\u001F\u007F]/.test(cleaned) ? cleaned : null;
};
const normalizedEmail = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(left)));
  const rightHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(right)));
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) difference |= leftHash[index]! ^ rightHash[index]!;
  return difference === 0;
}

async function requireSecret(request: Request, env: CsmEnv): Promise<void> {
  const supplied = request.headers.get("X-CSM-Distribution-Secret") || "";
  if (!env.CSM_DISTRIBUTION_SECRET || !(await secureEqual(supplied, env.CSM_DISTRIBUTION_SECRET))) {
    throw new HttpError(401, "Unauthorized distribution request.");
  }
}

async function requireWorkbookKey(env: CsmEnv, dataKey: unknown): Promise<void> {
  if (typeof dataKey !== "string" || dataKey.length < 1 || dataKey.length > 128) {
    throw new HttpError(401, "Your secure sign-in has expired. Sign in again and retry.");
  }
  const current = await fetchRepositoryWorkbook(env);
  if (!(await verifyDataKey(dataKey, current.payload.encryption.keyVerification))) {
    throw new HttpError(401, "Your secure sign-in has expired. Sign in again and retry.");
  }
}

const audit = (env: CsmEnv, entityId: string, eventType: string, metadata?: unknown): D1PreparedStatement =>
  env.DB.prepare(
    `INSERT INTO audit_events (id, entity_type, entity_id, event_type, metadata_json, created_at)
     VALUES (?1, 'csm_distribution', ?2, ?3, ?4, ?5)`,
  ).bind(crypto.randomUUID(), entityId, eventType, metadata === undefined ? null : JSON.stringify(metadata), new Date().toISOString());

async function inboxByKey(env: CsmEnv, key: string): Promise<InboxRow | null> {
  return env.DB.prepare(
    `SELECT id, idempotency_key, payload_json, status, matched_donor_id, match_method,
      recipient_record_id, callback_status, decision_reason FROM csm_distribution_inbox WHERE idempotency_key = ?1`,
  ).bind(key).first<InboxRow>();
}

async function matchDonor(env: CsmEnv, message: CsmDistributionMessage): Promise<{
  donorId: string | null; method: "master_link" | "email" | null; status: "pending" | "needs_match";
}> {
  if (message.transaction.direction === "sent") return { donorId: null, method: null, status: "pending" };
  const linked = await env.DB.prepare(
    "SELECT donor_id AS donorId FROM csm_donor_links WHERE master_donor_id = ?1",
  ).bind(message.masterDonorId).first<{ donorId: string }>();
  if (linked) return { donorId: linked.donorId, method: "master_link", status: "pending" };
  if (!message.party.email) return { donorId: null, method: null, status: "needs_match" };
  const candidates = await env.DB.prepare(
    "SELECT id FROM donors WHERE email_normalized = ?1 ORDER BY updated_at DESC LIMIT 2",
  ).bind(normalizedEmail(message.party.email)).all<{ id: string }>();
  return candidates.results.length === 1
    ? { donorId: candidates.results[0]!.id, method: "email", status: "pending" }
    : { donorId: null, method: null, status: "needs_match" };
}

async function receive(request: Request, env: CsmEnv): Promise<Response> {
  await requireSecret(request, env);
  const message = parseDistributionMessage(await request.json().catch(() => null));
  if (message.destination !== "JoshBeyondBorders") throw new HttpError(422, "This message is not for Josh Beyond Borders.");
  const duplicate = await inboxByKey(env, message.idempotencyKey);
  if (duplicate) return jsonResponse({ inboxId: duplicate.id, status: duplicate.status, recordId: duplicate.recipient_record_id, duplicate: true });
  const match = await matchDonor(env, message);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO csm_distribution_inbox
          (id, message_id, idempotency_key, schema_version, source_record_id, source_transaction_id,
           source_event_code, source_revision, direction, display_name, master_donor_id, payload_json,
           status, matched_donor_id, match_method, received_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
      ).bind(
        id, message.messageId, message.idempotencyKey, message.schemaVersion,
        message.transaction.sourceRecordId, message.transaction.paypalTransactionId,
        message.transaction.eventCode, message.sourceRevision, message.transaction.direction,
        message.displayName, message.masterDonorId, JSON.stringify(message), match.status,
        match.donorId, match.method, now,
      ),
      audit(env, id, "received", { direction: message.transaction.direction, displayName: message.displayName, matchMethod: match.method }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      const raced = await inboxByKey(env, message.idempotencyKey);
      if (raced) return jsonResponse({ inboxId: raced.id, status: raced.status, recordId: raced.recipient_record_id, duplicate: true });
    }
    throw error;
  }
  return jsonResponse({ inboxId: id, status: match.status, recordId: null }, 202);
}

async function candidates(env: CsmEnv, message: CsmDistributionMessage): Promise<DonorRow[]> {
  if (!message.party.email) return [];
  const result = await env.DB.prepare(
    "SELECT id, display_name, first_name, last_name, email FROM donors WHERE email_normalized = ?1 ORDER BY updated_at DESC LIMIT 10",
  ).bind(normalizedEmail(message.party.email)).all<DonorRow>();
  return result.results;
}

async function listInbox(request: Request, env: CsmEnv): Promise<Response> {
  const origin = requireAllowedOrigin(request, env);
  const body = await parseJsonRequest(request, 16_384, "The CSM inbox request could not be read.");
  if (!isObject(body)) throw new HttpError(400, "The CSM inbox request could not be read.");
  await requireWorkbookKey(env, body.dataKey);
  const status = typeof body.status === "string" ? body.status : "open";
  const allowed = ["pending", "needs_match", "approved", "denied", "failed"];
  if (status !== "open" && status !== "all" && !allowed.includes(status)) throw new HttpError(422, "Choose a valid inbox status.");
  const where = status === "all" ? "" : status === "open"
    ? "WHERE inbox.status IN ('pending', 'needs_match', 'failed')" : "WHERE inbox.status = ?1";
  const result = await env.DB.prepare(
    `SELECT inbox.id, inbox.idempotency_key, inbox.payload_json, inbox.status,
      inbox.matched_donor_id, inbox.match_method, inbox.decision_reason,
      inbox.recipient_record_id, inbox.callback_status, inbox.callback_error,
      inbox.received_at, inbox.updated_at, inbox.decided_at,
      donor.display_name AS matched_display_name, donor.email AS matched_email
     FROM csm_distribution_inbox AS inbox
     LEFT JOIN donors AS donor ON donor.id = inbox.matched_donor_id
     ${where} ORDER BY inbox.received_at DESC LIMIT 250`,
  ).bind(...(status === "open" || status === "all" ? [] : [status])).all<Record<string, unknown>>();
  const grouped = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM csm_distribution_inbox GROUP BY status")
    .all<{ status: string; count: number }>();
  const messages = await Promise.all(result.results.map(async row => {
    const message = parseDistributionMessage(JSON.parse(String(row.payload_json)));
    return {
      id: row.id, status: row.status, matchMethod: row.match_method, decisionReason: row.decision_reason,
      recordId: row.recipient_record_id, callbackStatus: row.callback_status, callbackError: row.callback_error,
      receivedAt: row.received_at, updatedAt: row.updated_at, decidedAt: row.decided_at,
      displayName: message.displayName, direction: message.transaction.direction,
      party: message.party, transaction: message.transaction,
      matchedDonor: row.matched_donor_id ? { id: row.matched_donor_id, displayName: row.matched_display_name, email: row.matched_email } : null,
      candidates: await candidates(env, message),
    };
  }));
  return jsonResponse({ messages, counts: Object.fromEntries(grouped.results.map(row => [row.status, Number(row.count)])) }, 200, origin);
}

async function inboxRecord(env: CsmEnv, id: string): Promise<{ row: InboxRow; message: CsmDistributionMessage }> {
  const row = await env.DB.prepare(
    `SELECT id, idempotency_key, payload_json, status, matched_donor_id, match_method,
      recipient_record_id, callback_status, decision_reason FROM csm_distribution_inbox WHERE id = ?1`,
  ).bind(id).first<InboxRow>();
  if (!row) throw new HttpError(404, "This CSM transaction was not found.");
  return { row, message: parseDistributionMessage(JSON.parse(row.payload_json)) };
}

async function notifyCsm(env: CsmEnv, row: InboxRow, status: InboxStatus, reason: string | null): Promise<"sent" | "failed"> {
  const now = new Date().toISOString();
  try {
    if (!env.CSM_STATUS || !env.CSM_DISTRIBUTION_SECRET) throw new Error("CSM status binding is not configured");
    const response = await env.CSM_STATUS.fetch("https://csm.internal/internal/csm-distribution/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSM-Distribution-Secret": env.CSM_DISTRIBUTION_SECRET },
      body: JSON.stringify({ idempotencyKey: row.idempotency_key, status, inboxId: row.id, recordId: row.recipient_record_id, reason }),
    });
    if (!response.ok) throw new Error(`CSM returned HTTP ${response.status}`);
    await env.DB.prepare(
      "UPDATE csm_distribution_inbox SET callback_status = 'sent', callback_attempts = callback_attempts + 1, callback_error = NULL, updated_at = ?1 WHERE id = ?2",
    ).bind(now, row.id).run();
    return "sent";
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown callback error";
    await env.DB.prepare(
      "UPDATE csm_distribution_inbox SET callback_status = 'failed', callback_attempts = callback_attempts + 1, callback_error = ?1, updated_at = ?2 WHERE id = ?3",
    ).bind(detail, now, row.id).run();
    return "failed";
  }
}

function donorFromBody(body: Record<string, unknown>, message: CsmDistributionMessage): {
  displayName: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null;
} {
  const donor = isObject(body.donor) ? body.donor : {};
  const displayName = cleanLine(donor.displayName ?? message.displayName, 160);
  if (!displayName) throw new HttpError(422, "Enter the donor's Display Name.");
  const email = cleanLine(donor.email ?? message.party.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail(email))) throw new HttpError(422, "Enter a valid donor email address.");
  return {
    displayName, firstName: cleanLine(donor.firstName, 70), lastName: cleanLine(donor.lastName, 70),
    email, phone: cleanLine(donor.phone ?? message.party.phone, 40),
  };
}

async function approve(request: Request, env: CsmEnv, id: string): Promise<Response> {
  const origin = requireAllowedOrigin(request, env);
  const body = await parseJsonRequest(request, 32_768, "The approval could not be read.");
  if (!isObject(body)) throw new HttpError(400, "The approval could not be read.");
  await requireWorkbookKey(env, body.dataKey);
  const { row, message } = await inboxRecord(env, id);
  if (row.status === "approved") return jsonResponse({ ok: true, status: "approved", recordId: row.recipient_record_id, duplicate: true }, 200, origin);
  if (row.status === "denied") throw new HttpError(409, "This transaction was already denied.");
  const statements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  let donorId: string | null = null;
  let matchMethod: string | null = null;
  if (message.transaction.direction === "received") {
    const requested = cleanLine(body.donorId, 64);
    donorId = requested || row.matched_donor_id;
    if (donorId) {
      const exists = await env.DB.prepare("SELECT id FROM donors WHERE id = ?1").bind(donorId).first<{ id: string }>();
      if (!exists) throw new HttpError(422, "Choose an existing donor or create a new one.");
      matchMethod = requested ? "manual" : row.match_method;
    } else {
      const donor = donorFromBody(body, message);
      donorId = crypto.randomUUID();
      matchMethod = "new_donor";
      const identityKey = donor.email ? `email:${normalizedEmail(donor.email)}` : `csm:${message.masterDonorId}`;
      statements.push(env.DB.prepare(
        `INSERT INTO donors
          (id, identity_key, display_name, first_name, last_name, email, email_normalized, phone,
           address_line_1, address_line_2, city, region, postal_code, country, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'csm', ?15, ?15)`,
      ).bind(
        donorId, identityKey, donor.displayName, donor.firstName, donor.lastName, donor.email,
        donor.email ? normalizedEmail(donor.email) : null, donor.phone, message.party.address?.line1,
        message.party.address?.line2, message.party.address?.city, message.party.address?.state,
        message.party.address?.postalCode, message.party.address?.countryCode, now,
      ));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO csm_donor_links (master_donor_id, donor_id, created_from_inbox_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (master_donor_id) DO UPDATE SET donor_id = excluded.donor_id, updated_at = excluded.updated_at`,
    ).bind(message.masterDonorId, donorId, id, now));
  }
  const recordId = crypto.randomUUID();
  statements.push(
    env.DB.prepare(
      `INSERT INTO financial_transactions
        (id, source_inbox_id, idempotency_key, paypal_transaction_id, paypal_event_code,
         transaction_date, direction, display_name, donor_id, currency, gross, fee, net,
         item_name, item_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).bind(
      recordId, id, row.idempotency_key, message.transaction.paypalTransactionId,
      message.transaction.eventCode, message.transaction.eventDate, message.transaction.direction,
      message.displayName, donorId, message.transaction.currency, message.transaction.gross,
      message.transaction.fee, message.transaction.net, message.transaction.itemName, message.transaction.itemId, now,
    ),
    env.DB.prepare(
      `UPDATE csm_distribution_inbox SET status = 'approved', matched_donor_id = ?1, match_method = ?2,
       recipient_record_id = ?3, callback_status = 'pending', decision_reason = NULL,
       decided_at = ?4, updated_at = ?4 WHERE id = ?5`,
    ).bind(donorId, matchMethod, recordId, now, id),
    audit(env, id, "approved", { recordId, donorId, matchMethod }),
  );
  await env.DB.batch(statements);
  const callbackStatus = await notifyCsm(env, { ...row, recipient_record_id: recordId }, "approved", null);
  return jsonResponse({ ok: true, status: "approved", recordId, donorId, callbackStatus }, 200, origin);
}

async function deny(request: Request, env: CsmEnv, id: string): Promise<Response> {
  const origin = requireAllowedOrigin(request, env);
  const body = await parseJsonRequest(request, 16_384, "The denial could not be read.");
  if (!isObject(body)) throw new HttpError(400, "The denial could not be read.");
  await requireWorkbookKey(env, body.dataKey);
  const reason = cleanLine(body.reason, 500);
  if (!reason) throw new HttpError(422, "Enter a reason for denying this transaction.");
  const { row } = await inboxRecord(env, id);
  if (row.status === "approved") throw new HttpError(409, "This transaction was already approved.");
  if (row.status === "denied") return jsonResponse({ ok: true, status: "denied", duplicate: true }, 200, origin);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE csm_distribution_inbox SET status = 'denied', decision_reason = ?1, callback_status = 'pending', decided_at = ?2, updated_at = ?2 WHERE id = ?3",
    ).bind(reason, now, id),
    audit(env, id, "denied", { reason }),
  ]);
  return jsonResponse({ ok: true, status: "denied", callbackStatus: await notifyCsm(env, row, "denied", reason) }, 200, origin);
}

async function retryNotification(request: Request, env: CsmEnv, id: string): Promise<Response> {
  const origin = requireAllowedOrigin(request, env);
  const body = await parseJsonRequest(request, 8_192, "The retry could not be read.");
  if (!isObject(body)) throw new HttpError(400, "The retry could not be read.");
  await requireWorkbookKey(env, body.dataKey);
  const { row } = await inboxRecord(env, id);
  if (row.status !== "approved" && row.status !== "denied") throw new HttpError(409, "Approve or deny this transaction before notifying CSM.");
  const callbackStatus = await notifyCsm(env, row, row.status, row.status === "denied" ? row.decision_reason : null);
  return jsonResponse({ ok: callbackStatus === "sent", callbackStatus }, 200, origin);
}

export async function handleCsmRequest(request: Request, env: CsmEnv, path: string): Promise<Response> {
  if (path === "/internal/csm-distribution") return receive(request, env);
  if (request.method === "POST" && path === "/api/admin/csm-inbox/list") return listInbox(request, env);
  const approveMatch = path.match(/^\/api\/admin\/csm-inbox\/([0-9a-f-]{36})\/approve$/i);
  if (request.method === "POST" && approveMatch) return approve(request, env, approveMatch[1]!);
  const denyMatch = path.match(/^\/api\/admin\/csm-inbox\/([0-9a-f-]{36})\/deny$/i);
  if (request.method === "POST" && denyMatch) return deny(request, env, denyMatch[1]!);
  const notifyMatch = path.match(/^\/api\/admin\/csm-inbox\/([0-9a-f-]{36})\/notify$/i);
  if (request.method === "POST" && notifyMatch) return retryNotification(request, env, notifyMatch[1]!);
  throw new HttpError(404, "Not found.");
}
