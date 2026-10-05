import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { currentMatchingGift } from "../src/matching-gift";

const testEnv = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const utf8ToBase64 = (value: string): string => bytesToBase64(new TextEncoder().encode(value));

const createCredential = async () => {
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const digest = await crypto.subtle.digest("SHA-256", dataKey);
  const payload = {
    version: 2,
    file: { name: "test.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 123 },
    encryption: {
      algorithm: "AES-256-GCM-ENVELOPE",
      data: {
        iv: bytesToBase64(crypto.getRandomValues(new Uint8Array(12))),
        ciphertext: bytesToBase64(crypto.getRandomValues(new Uint8Array(64))),
      },
      keyVerification: { algorithm: "SHA-256", digest: bytesToBase64(new Uint8Array(digest)) },
      access: {
        password: {
          keyDerivation: "PBKDF2-SHA-256", iterations: 310_000,
          salt: bytesToBase64(crypto.getRandomValues(new Uint8Array(16))),
          iv: bytesToBase64(crypto.getRandomValues(new Uint8Array(12))),
          wrappedKey: bytesToBase64(crypto.getRandomValues(new Uint8Array(48))),
        },
      },
    },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
    type: "file", encoding: "base64", sha: "credential-sha", content: utf8ToBase64(JSON.stringify(payload)),
  }));
  return dataKey;
};

const protectedRequest = (path: string, dataKey: Uint8Array, body: Record<string, unknown> = {}) =>
  worker.fetch(new Request(`https://joshbeyondborders.org${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://joshbeyondborders.org",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ dataKey: bytesToBase64(dataKey), ...body }),
  }), env);

let sequence = 0;
const insertGift = async (gross: number, transactionDate: string, donorName = "Example Donor") => {
  sequence += 1;
  const suffix = String(sequence);
  const donorId = crypto.randomUUID();
  const inboxId = crypto.randomUUID();
  const transactionId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO donors
        (id, identity_key, display_name, email, email_normalized, source, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4, 'csm', ?5, ?5)`,
    ).bind(donorId, `email:match-${suffix}@example.com`, donorName, `match-${suffix}@example.com`, transactionDate),
    env.DB.prepare(
      `INSERT INTO csm_distribution_inbox
        (id, message_id, idempotency_key, schema_version, source_record_id, source_transaction_id,
         source_event_code, source_revision, direction, display_name, master_donor_id, payload_json,
         status, matched_donor_id, match_method, recipient_record_id, callback_status,
         received_at, updated_at, decided_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, 'T0006', 1, 'received', ?6, ?7, '{}',
         'approved', ?8, 'new_donor', ?9, 'sent', ?10, ?10, ?10)`,
    ).bind(inboxId, crypto.randomUUID(), `match-test-${suffix}`, crypto.randomUUID(), `MATCH-${suffix}`, donorName, `master-${suffix}`, donorId, crypto.randomUUID(), transactionDate),
    env.DB.prepare(
      `INSERT INTO financial_transactions
        (id, source_inbox_id, idempotency_key, paypal_transaction_id, paypal_event_code,
         transaction_date, direction, display_name, donor_id, currency, gross, fee, net,
         item_name, item_id, created_at)
       VALUES (?1, ?2, ?3, ?4, 'T0006', ?5, 'received', ?6, ?7, 'USD', ?8, -2.00, ?9,
         'Josh Beyond Borders Donation', 'BeyondBorders', ?5)`,
    ).bind(transactionId, inboxId, `match-test-${suffix}`, `MATCH-${suffix}`, transactionDate, donorName, donorId, gross, gross - 2),
  ]);
  return transactionId;
};

describe("October 2026 matching gift", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    sequence = 0;
    await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM matching_gift_transaction_overrides"),
      env.DB.prepare("DELETE FROM financial_transactions"),
      env.DB.prepare("DELETE FROM csm_donor_links"),
      env.DB.prepare("DELETE FROM csm_distribution_inbox"),
      env.DB.prepare("DELETE FROM donor_contact_types"),
      env.DB.prepare("DELETE FROM donors"),
      env.DB.prepare("DELETE FROM audit_events"),
    ]);
  });

  it("counts approved gross gifts only inside the Central Time October 4–8 window", async () => {
    await insertGift(25, "2026-10-04T04:59:59.999Z", "Too Early");
    await insertGift(100, "2026-10-04T05:00:00.000Z", "First Qualifying Donor");
    await insertGift(50, "2026-10-09T04:59:59.999Z", "Last Qualifying Donor");
    await insertGift(75, "2026-10-09T05:00:00.000Z", "Too Late");

    const summary = await currentMatchingGift(env, new Date("2026-10-05T12:00:00.000Z"));
    expect(summary).toEqual(expect.objectContaining({
      qualifyingGross: 150,
      matchedAmount: 150,
      remainingMatch: 425,
      combinedImpact: 300,
      donationCount: 2,
      donorCount: 2,
      status: "active",
    }));
  });

  it("caps the unlocked match at $575 while retaining all qualifying community gifts", async () => {
    await insertGift(600, "2026-10-06T18:00:00.000Z");
    const summary = await currentMatchingGift(env, new Date("2026-10-06T20:00:00.000Z"));
    expect(summary).toEqual(expect.objectContaining({
      qualifyingGross: 600,
      matchedAmount: 575,
      remainingMatch: 0,
      combinedImpact: 1175,
      percent: 100,
      status: "fully_matched",
    }));
  });

  it("lets a signed-in Admin exclude the matching donor payment without removing the gift", async () => {
    const dataKey = await createCredential();
    const transactionId = await insertGift(150, "2026-10-04T16:00:00.000Z", "Matching Donor");
    const excluded = await protectedRequest("/api/admin/matching-gift/eligibility", dataKey, {
      campaignId: "october-2026-match",
      transactionId,
      eligibility: "exclude",
      note: "Matching donor payment",
    });
    expect(excluded.status).toBe(200);
    const summary = await currentMatchingGift(env, new Date("2026-10-05T12:00:00.000Z"));
    expect(summary).toEqual(expect.objectContaining({ qualifyingGross: 0, matchedAmount: 0 }));
    expect(await env.DB.prepare("SELECT gross FROM financial_transactions WHERE id = ?1").bind(transactionId).first())
      .toEqual(expect.objectContaining({ gross: 150 }));

    const restored = await protectedRequest("/api/admin/matching-gift/eligibility", dataKey, {
      campaignId: "october-2026-match",
      transactionId,
      eligibility: "automatic",
    });
    expect(restored.status).toBe(200);
    expect(await currentMatchingGift(env, new Date("2026-10-05T12:00:00.000Z")))
      .toEqual(expect.objectContaining({ qualifyingGross: 150, matchedAmount: 150 }));
  });

  it("publishes matching gift totals with the main guitar response", async () => {
    await insertGift(150, "2026-10-04T17:00:00.000Z");
    const response = await worker.fetch(
      new Request("https://joshbeyondborders.org/api/admin/giving-progress"),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { match: Record<string, unknown> };
    expect(body.match).toEqual(expect.objectContaining({
      id: "october-2026-match",
      qualifyingGross: 150,
      matchedAmount: 150,
      remainingMatch: 425,
    }));
  });
});
