import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
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
});
