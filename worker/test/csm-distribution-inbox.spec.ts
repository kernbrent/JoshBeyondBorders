import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { currentGivingSummary } from "../src/csm-distribution";
import type { CsmDistributionMessage } from "../src/csm-distribution-contract";

const testEnv = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const receivedMessage = (): CsmDistributionMessage => ({
  schemaVersion: 1,
  messageId: crypto.randomUUID(),
  idempotencyKey: "JoshBeyondBorders:PAYPAL-1:T0006:1",
  sourceRevision: 1,
  sentAt: "2026-08-23T12:00:00.000Z",
  destination: "JoshBeyondBorders",
  product: "JoshBeyondBorders",
  displayName: "Example Donor",
  masterDonorId: "csm-donor-1",
  party: { role: "donor", displayName: "Example Donor", email: "donor@example.com", phone: null, address: null },
  transaction: {
    sourceRecordId: "source-1", paypalTransactionId: "PAYPAL-1", paypalReferenceId: null,
    eventCode: "T0006", eventDate: "2026-08-23T11:00:00.000Z", status: "Completed",
    direction: "received", currency: "USD", gross: 100, fee: -2.48, net: 97.52,
    itemName: "Josh Beyond Borders Donation", itemId: "BeyondBorders",
  },
});

const deliver = (payload: CsmDistributionMessage, secret = "test-csm-distribution-secret") =>
  worker.fetch(new Request("https://csm.internal/internal/csm-distribution", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSM-Distribution-Secret": secret },
    body: JSON.stringify(payload),
  }), env);

describe("CSM distribution inbox", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM financial_transactions"),
      env.DB.prepare("DELETE FROM csm_donor_links"),
      env.DB.prepare("DELETE FROM csm_distribution_inbox"),
      env.DB.prepare("DELETE FROM donors"),
      env.DB.prepare("DELETE FROM audit_events"),
    ]);
  });

  it("stores a delivery once and returns the existing inbox for a retry", async () => {
    const payload = receivedMessage();
    const first = await deliver(payload);
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { inboxId: string; status: string };
    expect(firstBody.status).toBe("needs_match");

    const second = await deliver(payload);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(expect.objectContaining({ inboxId: firstBody.inboxId, duplicate: true }));

    const inbox = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM csm_distribution_inbox WHERE idempotency_key = ?1",
    ).bind(payload.idempotencyKey).first<{ count: number }>();
    const ledger = await env.DB.prepare("SELECT COUNT(*) AS count FROM financial_transactions").first<{ count: number }>();
    expect(Number(inbox?.count)).toBe(1);
    expect(Number(ledger?.count)).toBe(0);
  });

  it("rejects a bad secret without writing an inbox record", async () => {
    expect((await deliver(receivedMessage(), "wrong-secret")).status).toBe(401);
    const inbox = await env.DB.prepare("SELECT COUNT(*) AS count FROM csm_distribution_inbox").first<{ count: number }>();
    expect(Number(inbox?.count)).toBe(0);
  });

  it("accepts sent payments without creating a donor", async () => {
    const payload = receivedMessage();
    payload.idempotencyKey = "JoshBeyondBorders:PAYPAL-SENT:T0011:1";
    payload.displayName = "JBB Music";
    payload.masterDonorId = null;
    payload.party = { role: "payee", displayName: "JBB Music", email: "music@example.com", phone: null, address: null };
    payload.transaction = {
      ...payload.transaction, sourceRecordId: "source-sent", paypalTransactionId: "PAYPAL-SENT",
      eventCode: "T0011", direction: "sent", gross: -25, fee: 0, net: -25,
    };
    expect((await deliver(payload)).status).toBe(202);
    const donors = await env.DB.prepare("SELECT COUNT(*) AS count FROM donors").first<{ count: number }>();
    expect(Number(donors?.count)).toBe(0);
  });

  it("calculates current-year gross received, sent, donations, and unique givers", async () => {
    const first = receivedMessage();
    const second = receivedMessage();
    second.messageId = crypto.randomUUID();
    second.idempotencyKey = "JoshBeyondBorders:PAYPAL-2:T0006:1";
    second.transaction = {
      ...second.transaction,
      sourceRecordId: "source-2",
      paypalTransactionId: "PAYPAL-2",
      eventDate: "2026-08-24T11:00:00.000Z",
      gross: 50,
      fee: -1.49,
      net: 48.51,
    };
    const sent = receivedMessage();
    sent.messageId = crypto.randomUUID();
    sent.idempotencyKey = "JoshBeyondBorders:PAYPAL-SENT:T0011:1";
    sent.displayName = "JBB Music";
    sent.masterDonorId = null;
    sent.party = { role: "payee", displayName: "JBB Music", email: "music@example.com", phone: null, address: null };
    sent.transaction = {
      ...sent.transaction,
      sourceRecordId: "source-sent",
      paypalTransactionId: "PAYPAL-SENT",
      eventCode: "T0011",
      eventDate: "2026-08-24T12:00:00.000Z",
      direction: "sent",
      gross: -25,
      fee: 0,
      net: -25,
    };
    const delivered = [];
    for (const payload of [first, second, sent]) {
      const response = await deliver(payload);
      delivered.push((await response.json() as { inboxId: string }).inboxId);
    }
    const donorId = crypto.randomUUID();
    const now = "2026-08-24T13:00:00.000Z";
    const ledgerInsert = (inboxId: string, payload: CsmDistributionMessage, linkedDonorId: string | null) => env.DB.prepare(
      `INSERT INTO financial_transactions
        (id, source_inbox_id, idempotency_key, paypal_transaction_id, paypal_event_code,
         transaction_date, direction, display_name, donor_id, currency, gross, fee, net,
         item_name, item_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).bind(
      crypto.randomUUID(), inboxId, payload.idempotencyKey, payload.transaction.paypalTransactionId,
      payload.transaction.eventCode, payload.transaction.eventDate, payload.transaction.direction,
      payload.displayName, linkedDonorId, "USD", payload.transaction.gross, payload.transaction.fee,
      payload.transaction.net, payload.transaction.itemName, payload.transaction.itemId, now,
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO donors (id, identity_key, display_name, email, email_normalized, source, created_at, updated_at)
         VALUES (?1, ?2, 'Example Donor', 'donor@example.com', 'donor@example.com', 'csm', ?3, ?3)`,
      ).bind(donorId, `email:${first.party.email}`, now),
      ledgerInsert(delivered[0]!, first, donorId),
      ledgerInsert(delivered[1]!, second, donorId),
      ledgerInsert(delivered[2]!, sent, null),
    ]);
    const summary = await currentGivingSummary(env, new Date("2026-08-24T15:00:00.000Z"));
    expect(summary).toEqual(expect.objectContaining({ year: 2026, grossReceived: 150, sent: 25, donations: 2, givers: 1 }));
    expect(summary.netReceived).toBeCloseTo(146.03, 2);
  });
});
