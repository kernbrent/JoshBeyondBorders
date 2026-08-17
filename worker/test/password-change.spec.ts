import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { parseWorkbookPayload, verifyDataKey } from "../src/index";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

const CURRENT_PASSWORD = "Current#Pass8";
const NEW_PASSWORD = "Changed#Pass9";

type TestPasswordAccess = {
  keyDerivation: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  wrappedKey: string;
};

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

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const deriveWebCryptoPasswordKey = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
  usage: "encrypt" | "decrypt"
): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
};

const wrapWithWebCrypto = async (
  dataKey: Uint8Array,
  password: string,
  iterations = 310_000
): Promise<TestPasswordAccess> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWebCryptoPasswordKey(
    password,
    salt,
    iterations,
    "encrypt"
  );
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    dataKey
  );
  return {
    keyDerivation: "PBKDF2-SHA-256",
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    wrappedKey: bytesToBase64(new Uint8Array(wrappedKey)),
  };
};

const unwrapWithWebCrypto = async (
  access: TestPasswordAccess,
  password: string
): Promise<Uint8Array> => {
  const key = await deriveWebCryptoPasswordKey(
    password,
    base64ToBytes(access.salt),
    access.iterations,
    "decrypt"
  );
  const dataKey = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(access.iv) },
    key,
    base64ToBytes(access.wrappedKey)
  );
  return new Uint8Array(dataKey);
};

const createPayload = async () => {
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const password = await wrapWithWebCrypto(dataKey, CURRENT_PASSWORD);
  const digest = await crypto.subtle.digest("SHA-256", dataKey);
  return {
    dataKey,
    payload: {
      version: 2 as const,
      file: {
        name: "test.xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 123,
      },
      encryption: {
        algorithm: "AES-256-GCM-ENVELOPE" as const,
        data: {
          iv: bytesToBase64(crypto.getRandomValues(new Uint8Array(12))),
          ciphertext: bytesToBase64(crypto.getRandomValues(new Uint8Array(64))),
        },
        keyVerification: {
          algorithm: "SHA-256" as const,
          digest: bytesToBase64(new Uint8Array(digest)),
        },
        access: {
          password,
          recovery: { obsolete: true },
        },
      },
    },
  };
};

const changeRequest = async (
  dataKey: Uint8Array,
  overrides: Partial<{
    dataKey: string;
    passwordAccess: TestPasswordAccess;
  }> = {}
): Promise<Request> => {
  const passwordAccess = await wrapWithWebCrypto(dataKey, NEW_PASSWORD);
  return new Request("https://joshbeyondborders.org/api/admin/change-password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://joshbeyondborders.org",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({
      dataKey: bytesToBase64(dataKey),
      passwordAccess,
      ...overrides,
    }),
  });
};

describe("workbook-key verification", () => {
  it("accepts only the key represented by the stored fingerprint", async () => {
    const { dataKey, payload } = await createPayload();
    expect(await verifyDataKey(
      bytesToBase64(dataKey),
      payload.encryption.keyVerification
    )).toBe(true);
    expect(await verifyDataKey(
      bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
      payload.encryption.keyVerification
    )).toBe(false);
    expect(await verifyDataKey(
      bytesToBase64(crypto.getRandomValues(new Uint8Array(31))),
      payload.encryption.keyVerification
    )).toBe(false);
    expect(await verifyDataKey(
      "not base64!",
      payload.encryption.keyVerification
    )).toBe(false);
  });

  it("requires a valid fingerprint and exact password-wrapper byte lengths", async () => {
    const { payload } = await createPayload();
    expect(() => parseWorkbookPayload(payload)).not.toThrow();

    const withoutVerifier = structuredClone(payload);
    delete (withoutVerifier.encryption as Record<string, unknown>).keyVerification;
    expect(() => parseWorkbookPayload(withoutVerifier)).toThrow(
      "The secure workbook format is unavailable."
    );

    const malformedWrapper = structuredClone(payload);
    malformedWrapper.encryption.access.password.wrappedKey = bytesToBase64(
      crypto.getRandomValues(new Uint8Array(47))
    );
    expect(() => parseWorkbookPayload(malformedWrapper)).toThrow(
      "The secure workbook format is unavailable."
    );
  });
});

describe("Admin password API", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("saves only encrypted access and enables the browser-created new password", async () => {
    const { dataKey, payload } = await createPayload();
    let savedContent = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          return Response.json({
            type: "file",
            encoding: "base64",
            sha: "current-file-sha",
            content: utf8ToBase64(JSON.stringify(payload)),
          });
        }
        const update = await request.json<{
          content: string;
          sha: string;
          branch: string;
        }>();
        savedContent = update.content;
        expect(update.sha).toBe("current-file-sha");
        expect(update.branch).toBe("main");
        expect(request.headers.get("Authorization")).toBe("Bearer test-github-token");
        return Response.json({ commit: { sha: "new-commit-sha" } });
      }
    );

    const request = await changeRequest(dataKey);
    const transmitted = await request.clone().json<Record<string, unknown>>();
    expect(Object.keys(transmitted).sort()).toEqual(["dataKey", "passwordAccess"]);
    expect(JSON.stringify(transmitted)).not.toContain(CURRENT_PASSWORD);
    expect(JSON.stringify(transmitted)).not.toContain(NEW_PASSWORD);

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      message: "Password updated. You can sign in with the new password now.",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const saved = JSON.parse(base64ToUtf8(savedContent));
    expect(saved.encryption.access.recovery).toBeUndefined();
    expect(saved.encryption.data).toEqual(payload.encryption.data);
    expect(saved.encryption.keyVerification).toEqual(
      payload.encryption.keyVerification
    );
    expect(JSON.stringify(saved)).not.toContain(CURRENT_PASSWORD);
    expect(JSON.stringify(saved)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(saved)).not.toContain(bytesToBase64(dataKey));

    const unlocked = await unwrapWithWebCrypto(
      saved.encryption.access.password,
      NEW_PASSWORD
    );
    expect(Array.from(unlocked)).toEqual(Array.from(dataKey));
    await expect(
      unwrapWithWebCrypto(saved.encryption.access.password, CURRENT_PASSWORD)
    ).rejects.toThrow();
  });

  it("rejects a wrong workbook key without writing to GitHub", async () => {
    const { dataKey, payload } = await createPayload();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method !== "GET") throw new Error("Unexpected write.");
        return Response.json({
          type: "file",
          encoding: "base64",
          sha: "current-file-sha",
          content: utf8ToBase64(JSON.stringify(payload)),
        });
      }
    );
    const wrongKey = crypto.getRandomValues(new Uint8Array(32));
    const response = await worker.fetch(await changeRequest(wrongKey), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Your secure sign-in has expired. Sign in again and retry.",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(wrongKey)).not.toEqual(Array.from(dataKey));
  });

  it("rejects weak wrapper settings without writing to GitHub", async () => {
    const { dataKey, payload } = await createPayload();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method !== "GET") throw new Error("Unexpected write.");
        return Response.json({
          type: "file",
          encoding: "base64",
          sha: "current-file-sha",
          content: utf8ToBase64(JSON.stringify(payload)),
        });
      }
    );
    const weakAccess = await wrapWithWebCrypto(dataKey, NEW_PASSWORD, 100_000);
    const response = await worker.fetch(
      await changeRequest(dataKey, { passwordAccess: weakAccess }),
      env
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The new password protection is not strong enough.",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed encrypted access before contacting GitHub", async () => {
    const { dataKey } = await createPayload();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const malformedAccess = await wrapWithWebCrypto(dataKey, NEW_PASSWORD);
    malformedAccess.wrappedKey = bytesToBase64(
      crypto.getRandomValues(new Uint8Array(47))
    );
    const response = await worker.fetch(
      await changeRequest(dataKey, { passwordAccess: malformedAccess }),
      env
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects cross-site password changes before contacting GitHub", async () => {
    const { dataKey } = await createPayload();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const request = await changeRequest(dataKey);
    request.headers.set("Origin", "https://example.com");
    request.headers.set("Sec-Fetch-Site", "cross-site");
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves the current encrypted workbook without exposing the GitHub token", async () => {
    const { payload } = await createPayload();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      type: "file",
      encoding: "base64",
      sha: "current-file-sha",
      content: utf8ToBase64(JSON.stringify(payload)),
    }));
    const response = await worker.fetch(
      new Request("https://joshbeyondborders.org/api/admin/workbook"),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(payload);
  });
});
