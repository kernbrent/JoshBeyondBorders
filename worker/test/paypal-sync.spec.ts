import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { normalizeDonation } from "../src/index";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const utf8ToBase64 = (value: string): string =>
  bytesToBase64(new TextEncoder().encode(value));

const base64ToUtf8 = (value: string): string => {
  const binary = atob(value);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0))
  );
};

const createPayload = async () => {
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const digest = await crypto.subtle.digest("SHA-256", dataKey);
  return {
    dataKey,
    payload: {
      version: 2 as const,
      file: {
        name: "BeyondBordersReport-082026.xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 123,
      },
      encryption: {
        algorithm: "AES-256-GCM-ENVELOPE" as const,
        data: {
          iv: bytesToBase64(crypto.getRandomValues(new Uint8Array(12))),
          ciphertext: bytesToBase64(crypto.getRandomValues(new Uint8Array(139))),
        },
        keyVerification: {
          algorithm: "SHA-256" as const,
          digest: bytesToBase64(new Uint8Array(digest)),
        },
        access: {
          password: {
            keyDerivation: "PBKDF2-SHA-256" as const,
            iterations: 310_000,
            salt: bytesToBase64(crypto.getRandomValues(new Uint8Array(16))),
            iv: bytesToBase64(crypto.getRandomValues(new Uint8Array(12))),
            wrappedKey: bytesToBase64(crypto.getRandomValues(new Uint8Array(48))),
          },
        },
      },
    },
  };
};

const githubWorkbookResponse = (payload: unknown, sha = "current-file-sha") =>
  Response.json({
    type: "file",
    encoding: "base64",
    sha,
    content: utf8ToBase64(JSON.stringify(payload)),
  });

const adminPost = (path: string, body: unknown) => new Request(
  `https://joshbeyondborders.org${path}`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://joshbeyondborders.org",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  }
);

const paypalTransaction = (overrides: Record<string, unknown> = {}) => ({
  transaction_info: {
    transaction_id: "PAYPAL-DONATION-1",
    transaction_event_code: "T0006",
    transaction_initiation_date: "2026-08-20T20:15:00Z",
    transaction_updated_date: "2026-08-20T20:16:00Z",
    transaction_status: "S",
    transaction_amount: { currency_code: "USD", value: "50.00" },
    fee_amount: { currency_code: "USD", value: "-1.49" },
    ...overrides,
  },
  payer_info: {
    email_address: "donor@example.com",
    address_status: "Y",
    payer_name: { given_name: "Test", surname: "Donor" },
    address: {
      address_line_1: "1 Test Lane",
      admin_area_2: "McKinney",
      admin_area_1: "TX",
      postal_code: "75072",
      country_code: "US",
    },
  },
  cart_info: {
    item_details: [{
      item_name: "Josh Beyond Borders Donation",
      item_code: "BeyondBorders",
      quantity: "1",
    }],
  },
});

describe("PayPal donation filtering", () => {
  it("accepts only a completed positive USD payment for the exact campaign", () => {
    const accepted = normalizeDonation(paypalTransaction(), env);
    expect(accepted).toMatchObject({
      transactionId: "PAYPAL-DONATION-1",
      eventCode: "T0006",
      gross: 50,
      fee: -1.49,
      net: 48.51,
      itemTitle: "Josh Beyond Borders Donation",
      itemId: "BeyondBorders",
      payerEmail: "donor@example.com",
    });

    const otherCampaign = paypalTransaction();
    (otherCampaign.cart_info.item_details[0] as Record<string, unknown>).item_code = "Other";
    expect(normalizeDonation(otherCampaign, env)).toBeNull();
    const mixedCampaign = paypalTransaction();
    mixedCampaign.cart_info.item_details.push({
      item_name: "Unrelated Item",
      item_code: "Other",
      quantity: "1",
    });
    expect(normalizeDonation(mixedCampaign, env)).toBeNull();
    expect(normalizeDonation(paypalTransaction({
      transaction_event_code: "T0400",
    }), env)).toBeNull();
    expect(normalizeDonation(paypalTransaction({
      transaction_amount: { currency_code: "USD", value: "-50.00" },
    }), env)).toBeNull();
    expect(normalizeDonation(paypalTransaction({
      transaction_status: "V",
    }), env)).toBeNull();
  });
});

describe("PayPal sync API", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns only exact campaign donations and deduplicates overlapping reports", async () => {
    const { dataKey, payload } = await createPayload();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "api.github.com") {
          return githubWorkbookResponse(payload);
        }
        if (url.pathname === "/v1/oauth2/token") {
          expect(request.method).toBe("POST");
          expect(request.headers.get("Authorization")).toMatch(/^Basic /);
          const tokenRequest = await request.formData();
          expect(tokenRequest.get("grant_type")).toBe("client_credentials");
          expect(tokenRequest.get("scope")).toBe(
            "https://uri.paypal.com/services/reporting/search/read"
          );
          return Response.json({
            access_token: "test-access-token",
            scope: "https://uri.paypal.com/services/reporting/search/read",
          });
        }
        expect(url.pathname).toBe("/v1/reporting/transactions");
        expect(url.searchParams.get("fields")).toBe("all");
        expect(url.searchParams.get("transaction_status")).toBe("S");
        expect(url.searchParams.get("balance_affecting_records_only")).toBe("Y");
        const otherCampaign = paypalTransaction();
        (otherCampaign.cart_info.item_details[0] as Record<string, unknown>).item_name = "Other Campaign";
        return Response.json({
          total_pages: 1,
          transaction_details: [
            paypalTransaction(),
            otherCampaign,
            paypalTransaction({ transaction_event_code: "T0400" }),
          ],
        });
      }
    );

    const response = await worker.fetch(adminPost(
      "/api/admin/paypal-donations",
      { dataKey: bytesToBase64(dataKey) }
    ), env);
    expect(response.status).toBe(200);
    const result = await response.json<{
      donations: Array<{ transactionId: string }>;
      itemTitle: string;
      itemId: string;
    }>();
    expect(result.itemTitle).toBe("Josh Beyond Borders Donation");
    expect(result.itemId).toBe("BeyondBorders");
    expect(result.donations).toHaveLength(1);
    expect(result.donations[0]?.transactionId).toBe("PAYPAL-DONATION-1");
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it("publishes the encrypted workbook and public total in one Git commit", async () => {
    const { dataKey, payload } = await createPayload();
    const revision = "current-file-sha";
    let workbookBlobContent = "";
    let progressBlobContent = "";
    let updatedRefBody: Record<string, unknown> = {};

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.includes("/contents/")) {
          return githubWorkbookResponse(payload, revision);
        }
        if (request.method === "GET" && url.pathname.endsWith("/git/ref/heads/main")) {
          return Response.json({ object: { sha: "parent-commit-sha" } });
        }
        if (request.method === "GET" && url.pathname.endsWith("/git/commits/parent-commit-sha")) {
          return Response.json({ tree: { sha: "parent-tree-sha" } });
        }
        if (request.method === "POST" && url.pathname.endsWith("/git/blobs")) {
          const body = await request.json<{ content: string }>();
          const content = base64ToUtf8(body.content);
          if (content.includes('"raised": 850')) {
            progressBlobContent = content;
            return Response.json({ sha: "progress-blob-sha" });
          }
          workbookBlobContent = content;
          return Response.json({ sha: "workbook-blob-sha" });
        }
        if (request.method === "POST" && url.pathname.endsWith("/git/trees")) {
          const body = await request.json<{ tree: Array<Record<string, unknown>> }>();
          expect(body.tree).toEqual([
            {
              path: "admin/resources/giving-workbook.enc.json",
              mode: "100644",
              type: "blob",
              sha: "workbook-blob-sha",
            },
            {
              path: "data/giving-progress.json",
              mode: "100644",
              type: "blob",
              sha: "progress-blob-sha",
            },
          ]);
          return Response.json({ sha: "next-tree-sha" });
        }
        if (request.method === "POST" && url.pathname.endsWith("/git/commits")) {
          return Response.json({ sha: "next-commit-sha" });
        }
        if (request.method === "PATCH" && url.pathname.endsWith("/git/refs/heads/main")) {
          updatedRefBody = await request.json<Record<string, unknown>>();
          return Response.json({ object: { sha: "next-commit-sha" } });
        }
        throw new Error(`Unexpected GitHub request: ${request.method} ${request.url}`);
      }
    );

    const fileSize = 200;
    const nextData = {
      iv: bytesToBase64(crypto.getRandomValues(new Uint8Array(12))),
      ciphertext: bytesToBase64(crypto.getRandomValues(new Uint8Array(fileSize + 16))),
    };
    const response = await worker.fetch(adminPost(
      "/api/admin/publish-giving",
      {
        dataKey: bytesToBase64(dataKey),
        expectedRevision: revision,
        file: {
          name: "BeyondBordersReport-082126.xlsx",
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: fileSize,
        },
        data: nextData,
        raised: 850,
      }
    ), env);
    expect(response.status).toBe(200);
    const result = await response.json<{
      ok: boolean;
      revision: string;
      progress: { raised: number; goal: number; percent: number };
    }>();
    expect(result).toMatchObject({
      ok: true,
      revision: "workbook-blob-sha",
      progress: { raised: 850, goal: 7500, percent: 11.33 },
    });
    expect(updatedRefBody).toEqual({ sha: "next-commit-sha", force: false });

    const savedWorkbook = JSON.parse(workbookBlobContent);
    expect(savedWorkbook.file.name).toBe("BeyondBordersReport-082126.xlsx");
    expect(savedWorkbook.encryption.data).toEqual(nextData);
    expect(savedWorkbook.encryption.access).toEqual(payload.encryption.access);
    expect(savedWorkbook.encryption.keyVerification).toEqual(
      payload.encryption.keyVerification
    );
    expect(progressBlobContent).toContain('"raised": 850');
    expect(workbookBlobContent).not.toContain(bytesToBase64(dataKey));
  });
});
