import { fetchRepositoryWorkbook, verifyDataKey } from "./workbook-repository";
import { HttpError, isObject, jsonResponse, parseJsonRequest, requireAllowedOrigin } from "./shared";

type MatchEnv = Env & { DB: D1Database };
type CampaignRow = {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  match_cap: number;
  match_ratio: number;
  item_id: string | null;
  status: "active" | "completed" | "cancelled";
  updated_at: string;
};
type MatchSummaryRow = {
  qualifying_gross: number | null;
  donation_count: number | null;
  donor_count: number | null;
  updated_at: string | null;
};

const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

async function requireWorkbookKey(env: MatchEnv, dataKey: unknown): Promise<void> {
  if (typeof dataKey !== "string" || dataKey.length < 1 || dataKey.length > 128) {
    throw new HttpError(401, "Your secure sign-in has expired. Sign in again and retry.");
  }
  const current = await fetchRepositoryWorkbook(env);
  if (!(await verifyDataKey(dataKey, current.payload.encryption.keyVerification))) {
    throw new HttpError(401, "Your secure sign-in has expired. Sign in again and retry.");
  }
}

async function selectedCampaign(env: MatchEnv, at: Date): Promise<CampaignRow | null> {
  const now = at.toISOString();
  return env.DB.prepare(
    `SELECT id, title, start_at, end_at, match_cap, match_ratio, item_id, status, updated_at
     FROM matching_gift_campaigns
     WHERE status != 'cancelled'
     ORDER BY
       CASE WHEN start_at <= ?1 AND end_at > ?1 AND status = 'active' THEN 0
            WHEN start_at > ?1 AND status = 'active' THEN 1 ELSE 2 END,
       start_at DESC
     LIMIT 1`,
  ).bind(now).first<CampaignRow>();
}

export type MatchingGiftSummary = {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  cap: number;
  ratio: number;
  qualifyingGross: number;
  matchedAmount: number;
  remainingMatch: number;
  combinedImpact: number;
  donationCount: number;
  donorCount: number;
  percent: number;
  status: "upcoming" | "active" | "fully_matched" | "ended";
  updatedAt: string;
};

export async function currentMatchingGift(
  env: MatchEnv,
  at = new Date(),
): Promise<MatchingGiftSummary | null> {
  const campaign = await selectedCampaign(env, at);
  if (!campaign) return null;
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(tx.gross), 0) AS qualifying_gross,
       COUNT(tx.id) AS donation_count,
       COUNT(DISTINCT tx.donor_id) AS donor_count,
       MAX(tx.created_at) AS updated_at
     FROM financial_transactions AS tx
     LEFT JOIN matching_gift_transaction_overrides AS override
       ON override.campaign_id = ?1 AND override.transaction_id = tx.id
     WHERE tx.direction = 'received'
       AND tx.transaction_date >= ?2 AND tx.transaction_date < ?3
       AND override.transaction_id IS NULL`,
  ).bind(campaign.id, campaign.start_at, campaign.end_at).first<MatchSummaryRow>();
  const qualifyingGross = money(Number(row?.qualifying_gross ?? 0));
  const cap = money(Number(campaign.match_cap));
  const ratio = Number(campaign.match_ratio);
  const matchedAmount = money(Math.min(cap, qualifyingGross * ratio));
  const remainingMatch = money(Math.max(0, cap - matchedAmount));
  const combinedImpact = money(qualifyingGross + matchedAmount);
  const now = at.toISOString();
  const status = now < campaign.start_at
    ? "upcoming"
    : now >= campaign.end_at || campaign.status === "completed"
      ? "ended"
      : remainingMatch === 0
        ? "fully_matched"
        : "active";
  return {
    id: campaign.id,
    title: campaign.title,
    startAt: campaign.start_at,
    endAt: campaign.end_at,
    cap,
    ratio,
    qualifyingGross,
    matchedAmount,
    remainingMatch,
    combinedImpact,
    donationCount: Number(row?.donation_count ?? 0),
    donorCount: Number(row?.donor_count ?? 0),
    percent: cap ? Math.round((matchedAmount / cap) * 10_000) / 100 : 0,
    status,
    updatedAt: row?.updated_at || campaign.updated_at,
  };
}

async function listCampaign(request: Request, env: MatchEnv): Promise<Response> {
  const origin = requireAllowedOrigin(request, env);
  const body = await parseJsonRequest(request, 16_384, "The matching gift request could not be read.");
  if (!isObject(body)) throw new HttpError(400, "The matching gift request could not be read.");
  await requireWorkbookKey(env, body.dataKey);
  const summary = await currentMatchingGift(env);
  if (!summary) return jsonResponse({ campaign: null, transactions: [] }, 200, origin);
  const result = await env.DB.prepare(
    `SELECT tx.id, tx.transaction_date, tx.display_name, tx.gross, tx.net,
       tx.paypal_transaction_id, tx.item_name, tx.item_id,
       donor.display_name AS donor_name, donor.email,
       override.eligibility, override.note
     FROM financial_transactions AS tx
     LEFT JOIN donors AS donor ON donor.id = tx.donor_id
     LEFT JOIN matching_gift_transaction_overrides AS override
       ON override.campaign_id = ?1 AND override.transaction_id = tx.id
     WHERE tx.direction = 'received'
       AND tx.transaction_date >= ?2 AND tx.transaction_date < ?3
     ORDER BY tx.transaction_date DESC, tx.created_at DESC`,
  ).bind(summary.id, summary.startAt, summary.endAt).all<Record<string, unknown>>();
  const transactions = result.results.map(row => ({
    id: String(row.id),
    transactionDate: String(row.transaction_date),
    displayName: String(row.donor_name || row.display_name || "Unnamed donor"),
    email: row.email ? String(row.email) : "",
    gross: Number(row.gross),
    net: Number(row.net),
    paypalTransactionId: String(row.paypal_transaction_id),
    itemName: row.item_name ? String(row.item_name) : "",
    itemId: row.item_id ? String(row.item_id) : "",
    eligibility: row.eligibility === "exclude" ? "exclude" : "automatic",
    note: row.note ? String(row.note) : "",
  }));
  return jsonResponse({ campaign: summary, transactions }, 200, origin);
}

async function setEligibility(request: Request, env: MatchEnv): Promise<Response> {
  const origin = requireAllowedOrigin(request, env);
  const body = await parseJsonRequest(request, 16_384, "The matching gift update could not be read.");
  if (!isObject(body)) throw new HttpError(400, "The matching gift update could not be read.");
  await requireWorkbookKey(env, body.dataKey);
  const campaignId = typeof body.campaignId === "string" ? body.campaignId : "";
  const transactionId = typeof body.transactionId === "string" ? body.transactionId : "";
  const eligibility = body.eligibility;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!campaignId || !transactionId || !["automatic", "exclude"].includes(String(eligibility))) {
    throw new HttpError(422, "Choose whether this gift should count toward the match.");
  }
  const transaction = await env.DB.prepare(
    `SELECT tx.id FROM financial_transactions AS tx
     JOIN matching_gift_campaigns AS campaign ON campaign.id = ?1
     WHERE tx.id = ?2 AND tx.direction = 'received'
       AND tx.transaction_date >= campaign.start_at AND tx.transaction_date < campaign.end_at`,
  ).bind(campaignId, transactionId).first<{ id: string }>();
  if (!transaction) throw new HttpError(404, "That qualifying gift could not be found.");
  const now = new Date().toISOString();
  if (eligibility === "automatic") {
    await env.DB.prepare(
      "DELETE FROM matching_gift_transaction_overrides WHERE campaign_id = ?1 AND transaction_id = ?2",
    ).bind(campaignId, transactionId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO matching_gift_transaction_overrides
         (campaign_id, transaction_id, eligibility, note, updated_at)
       VALUES (?1, ?2, 'exclude', ?3, ?4)
       ON CONFLICT (campaign_id, transaction_id) DO UPDATE SET
         eligibility = 'exclude', note = excluded.note, updated_at = excluded.updated_at`,
    ).bind(campaignId, transactionId, note || null, now).run();
  }
  await env.DB.prepare(
    `INSERT INTO audit_events (id, entity_type, entity_id, event_type, metadata_json, created_at)
     VALUES (?1, 'matching_gift', ?2, 'eligibility_updated', ?3, ?4)`,
  ).bind(crypto.randomUUID(), campaignId, JSON.stringify({ transactionId, eligibility, note }), now).run();
  return jsonResponse({ ok: true, campaign: await currentMatchingGift(env) }, 200, origin);
}

export async function handleMatchingGiftRequest(
  request: Request,
  env: MatchEnv,
  path: string,
): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed.");
  if (path === "/api/admin/matching-gift/list") return listCampaign(request, env);
  if (path === "/api/admin/matching-gift/eligibility") return setEligibility(request, env);
  throw new HttpError(404, "Not found.");
}
