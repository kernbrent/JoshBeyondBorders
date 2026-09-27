import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

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

const request = (path: string, dataKey: Uint8Array, body: Record<string, unknown> = {}) =>
  worker.fetch(new Request(`https://joshbeyondborders.org${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://joshbeyondborders.org",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ dataKey: bytesToBase64(dataKey), ...body }),
  }), env);

const insertGivingDonor = async () => {
  const donorId = crypto.randomUUID();
  const inboxId = crypto.randomUUID();
  const now = "2026-09-20T12:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO donors
        (id, identity_key, display_name, first_name, last_name, email, email_normalized, phone,
         phone_normalized, contact_status, contact_preference, source, created_at, updated_at)
       VALUES (?1, ?2, 'Existing Giver', 'Existing', 'Giver', 'giver@example.com', 'giver@example.com',
         '(972) 555-0101', '9725550101', 'active', 'email', 'csm', ?3, ?3)`,
    ).bind(donorId, `email:giver@example.com`, now),
    env.DB.prepare(
      "INSERT INTO donor_contact_types (donor_id, contact_type, created_at) VALUES (?1, 'donor', ?2)",
    ).bind(donorId, now),
    env.DB.prepare(
      `INSERT INTO csm_distribution_inbox
        (id, message_id, idempotency_key, schema_version, source_record_id, source_transaction_id,
         source_event_code, source_revision, direction, display_name, master_donor_id, payload_json,
         status, matched_donor_id, match_method, recipient_record_id, callback_status, received_at, updated_at, decided_at)
       VALUES (?1, ?2, ?3, 1, ?4, 'CONTACT-TX-1', 'T0006', 1, 'received', 'Existing Giver',
         'master-giver', '{}', 'approved', ?5, 'new_donor', ?6, 'sent', ?7, ?7, ?7)`,
    ).bind(inboxId, crypto.randomUUID(), "contact-test-idempotency", crypto.randomUUID(), donorId, crypto.randomUUID(), now),
    env.DB.prepare(
      `INSERT INTO financial_transactions
        (id, source_inbox_id, idempotency_key, paypal_transaction_id, paypal_event_code,
         transaction_date, direction, display_name, donor_id, currency, gross, fee, net,
         item_name, item_id, created_at)
       VALUES (?1, ?2, 'contact-test-idempotency', 'CONTACT-TX-1', 'T0006', ?3, 'received',
         'Existing Giver', ?4, 'USD', 125, -3.25, 121.75, 'Josh Beyond Borders Donation', 'BeyondBorders', ?3)`,
    ).bind(crypto.randomUUID(), inboxId, now, donorId),
  ]);
  return donorId;
};

describe("protected contact directory", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM financial_transactions"),
      env.DB.prepare("DELETE FROM csm_donor_links"),
      env.DB.prepare("DELETE FROM csm_distribution_inbox"),
      env.DB.prepare("DELETE FROM donor_contact_types"),
      env.DB.prepare("DELETE FROM donors"),
      env.DB.prepare("DELETE FROM audit_events"),
    ]);
  });

  it("lists existing giving donors with contact details and totals", async () => {
    const dataKey = await createCredential();
    const donorId = await insertGivingDonor();
    const response = await request("/api/admin/contacts/list", dataKey);
    expect(response.status).toBe(200);
    const result = await response.json() as { contacts: Array<Record<string, unknown>>; summary: Record<string, number> };
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toEqual(expect.objectContaining({
      id: donorId,
      displayName: "Existing Giver",
      email: "giver@example.com",
      giftCount: 1,
      lifetimeGiving: 125,
      netReceived: 121.75,
      contactTypes: ["donor"],
    }));
    expect(result.summary).toEqual(expect.objectContaining({ shown: 1, active: 1, donors: 1, lifetimeGiving: 125 }));
  });

  it("creates, edits, filters, and records follow-up for a ministry contact", async () => {
    const dataKey = await createCredential();
    const created = await request("/api/admin/contacts/save", dataKey, {
      contact: {
        displayName: "Venue Coordinator", firstName: "Venue", lastName: "Coordinator",
        email: "venue@example.com", phone: "972-555-0199", contactPreference: "email",
        contactStatus: "active", organization: "Example Church", contactTypes: ["venue_contact"],
      },
    });
    expect(created.status).toBe(201);
    const { contactId } = await created.json() as { contactId: string };

    const activity = await request("/api/admin/contacts/bulk-activity", dataKey, {
      contactIds: [contactId], lastContactedAt: "2026-09-26", lastContactedNote: "Called about a concert",
    });
    expect(activity.status).toBe(200);
    expect(await activity.json()).toEqual(expect.objectContaining({ updated: 1 }));

    const filtered = await request("/api/admin/contacts/list", dataKey, { contactType: "venue_contact", search: "example church" });
    expect(filtered.status).toBe(200);
    const body = await filtered.json() as { contacts: Array<Record<string, unknown>> };
    expect(body.contacts).toEqual([expect.objectContaining({
      id: contactId, displayName: "Venue Coordinator", lastContactedAt: "2026-09-26",
      lastContactedNote: "Called about a concert", contactTypes: ["venue_contact"],
    })]);
  });

  it("deletes only unlinked contacts and retains giving records", async () => {
    const dataKey = await createCredential();
    const donorId = await insertGivingDonor();
    const blocked = await request("/api/admin/contacts/delete", dataKey, { contactId: donorId });
    expect(blocked.status).toBe(409);

    const created = await request("/api/admin/contacts/save", dataKey, {
      contact: { displayName: "Temporary Contact", email: "temporary@example.com", contactPreference: "email", contactTypes: ["supporter"] },
    });
    const { contactId } = await created.json() as { contactId: string };
    expect((await request("/api/admin/contacts/delete", dataKey, { contactId })).status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM donors WHERE id = ?1").bind(contactId).first()).toBeNull();
  });

  it("rejects an invalid workbook key", async () => {
    await createCredential();
    const wrongKey = crypto.getRandomValues(new Uint8Array(32));
    const response = await request("/api/admin/contacts/list", wrongKey);
    expect(response.status).toBe(401);
  });
});
