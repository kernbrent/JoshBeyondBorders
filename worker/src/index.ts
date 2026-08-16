import {
  createCipheriv,
  createDecipheriv,
  pbkdf2,
} from "node:crypto";

const PBKDF2_ITERATIONS = 310_000;
const MAX_REQUEST_BYTES = 4_096;
const MAX_GITHUB_RESPONSE_BYTES = 200_000;
const GITHUB_API_VERSION = "2026-03-10";
const AES_GCM_TAG_BYTES = 16;

type JsonObject = Record<string, unknown>;

type PasswordAccess = {
  keyDerivation: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  wrappedKey: string;
};

type WorkbookPayload = {
  version: 2;
  file: {
    name: string;
    type: string;
    size: number;
  };
  encryption: {
    algorithm: "AES-256-GCM-ENVELOPE";
    data: {
      iv: string;
      ciphertext: string;
    };
    access: {
      password: PasswordAccess;
    };
  };
};

type RepositoryWorkbook = {
  payload: WorkbookPayload;
  sha: string;
};

class HttpError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonemptyString = (value: unknown, maximum = 200_000): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const isPasswordAccess = (value: unknown): value is PasswordAccess => {
  if (!isObject(value)) return false;
  return value.keyDerivation === "PBKDF2-SHA-256" &&
    typeof value.iterations === "number" &&
    Number.isInteger(value.iterations) &&
    value.iterations >= 100_000 &&
    value.iterations <= 2_000_000 &&
    isNonemptyString(value.salt, 256) &&
    isNonemptyString(value.iv, 256) &&
    isNonemptyString(value.wrappedKey, 512);
};

const parseWorkbookPayload = (value: unknown): WorkbookPayload => {
  if (!isObject(value) || value.version !== 2 || !isObject(value.file) ||
      !isObject(value.encryption) || !isObject(value.encryption.data) ||
      !isObject(value.encryption.access)) {
    throw new HttpError(503, "The secure workbook format is unavailable.");
  }
  if (value.encryption.algorithm !== "AES-256-GCM-ENVELOPE" ||
      !isNonemptyString(value.file.name, 512) ||
      !isNonemptyString(value.file.type, 256) ||
      typeof value.file.size !== "number" ||
      !Number.isSafeInteger(value.file.size) ||
      value.file.size < 1 ||
      !isNonemptyString(value.encryption.data.iv, 256) ||
      !isNonemptyString(value.encryption.data.ciphertext) ||
      !isPasswordAccess(value.encryption.access.password)) {
    throw new HttpError(503, "The secure workbook format is unavailable.");
  }
  return value as WorkbookPayload;
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

const utf8ToBase64 = (value: string): string =>
  bytesToBase64(new TextEncoder().encode(value));

const base64ToUtf8 = (value: string): string =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
    .decode(base64ToBytes(value));

const derivePasswordKey = (
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, 32, "sha256", (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });

const joinBytes = (...chunks: Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const unwrapDataKey = async (
  access: PasswordAccess,
  password: string
): Promise<Uint8Array> => {
  const key = await derivePasswordKey(
    password,
    base64ToBytes(access.salt),
    access.iterations
  );
  try {
    const wrappedKey = base64ToBytes(access.wrappedKey);
    if (wrappedKey.byteLength <= AES_GCM_TAG_BYTES) {
      throw new Error("Invalid wrapped key length.");
    }
    const ciphertext = wrappedKey.subarray(
      0,
      wrappedKey.byteLength - AES_GCM_TAG_BYTES
    );
    const authTag = wrappedKey.subarray(
      wrappedKey.byteLength - AES_GCM_TAG_BYTES
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      base64ToBytes(access.iv),
      { authTagLength: AES_GCM_TAG_BYTES }
    );
    decipher.setAuthTag(authTag);
    const bytes = joinBytes(decipher.update(ciphertext), decipher.final());
    if (bytes.byteLength !== 32) throw new Error("Invalid data key length.");
    return bytes;
  } finally {
    key.fill(0);
  }
};

const wrapDataKey = async (
  dataKeyBytes: Uint8Array,
  password: string,
  iterations: number
): Promise<PasswordAccess> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePasswordKey(password, salt, iterations);
  try {
    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      iv,
      { authTagLength: AES_GCM_TAG_BYTES }
    );
    const wrappedKey = joinBytes(
      cipher.update(dataKeyBytes),
      cipher.final(),
      cipher.getAuthTag()
    );
    return {
      keyDerivation: "PBKDF2-SHA-256",
      iterations,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      wrappedKey: bytesToBase64(wrappedKey),
    };
  } finally {
    key.fill(0);
  }
};

const passwordRequirementError = (value: string): string => {
  const meetsRequirements = value.length >= 8 &&
    value.length <= 256 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value) &&
    /[^A-Za-z0-9\s]/.test(value);
  return meetsRequirements
    ? ""
    : "Use at least 8 characters with lowercase, uppercase, a number, and a special character.";
};

const githubHeaders = (env: Env): Headers => new Headers({
  "Accept": "application/vnd.github+json",
  "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
  "User-Agent": "JoshBeyondBorders-Admin-API",
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
});

const githubContentsUrl = (env: Env): string => {
  const path = env.WORKBOOK_PATH
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${path}`;
};

const fetchRepositoryWorkbook = async (env: Env): Promise<RepositoryWorkbook> => {
  const url = new URL(githubContentsUrl(env));
  url.searchParams.set("ref", env.GITHUB_BRANCH);
  const response = await fetch(url, { headers: githubHeaders(env) });
  if (!response.ok) {
    throw new HttpError(503, "The secure workbook could not be loaded.");
  }
  const contentLength = Number(response.headers.get("Content-Length") || 0);
  if (contentLength > MAX_GITHUB_RESPONSE_BYTES) {
    throw new HttpError(503, "The secure workbook response is too large.");
  }
  const result: unknown = await response.json();
  if (!isObject(result) || result.type !== "file" ||
      result.encoding !== "base64" || !isNonemptyString(result.sha, 128) ||
      !isNonemptyString(result.content, MAX_GITHUB_RESPONSE_BYTES)) {
    throw new HttpError(503, "The secure workbook response is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64ToUtf8(result.content));
  } catch (error) {
    throw new HttpError(503, "The secure workbook response is invalid.");
  }
  return { payload: parseWorkbookPayload(parsed), sha: result.sha };
};

const saveRepositoryWorkbook = async (
  env: Env,
  payload: WorkbookPayload,
  sha: string
): Promise<void> => {
  const headers = githubHeaders(env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  const response = await fetch(githubContentsUrl(env), {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: "Change Admin password",
      content: utf8ToBase64(`${JSON.stringify(payload, null, 2)}\n`),
      sha,
      branch: env.GITHUB_BRANCH,
    }),
  });
  if (response.status === 409 || response.status === 422) {
    throw new HttpError(409, "The password changed elsewhere. Please reload and try again.");
  }
  if (!response.ok) {
    throw new HttpError(503, "GitHub could not save the password change.");
  }
};

const securityHeaders = (): Headers => new Headers({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

const jsonResponse = (
  body: JsonObject,
  status = 200,
  origin = ""
): Response => {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return Response.json(body, { status, headers });
};

const readBoundedText = async (request: Request): Promise<string> => {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        throw new HttpError(413, "The request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
};

const requireAllowedOrigin = (request: Request, env: Env): string => {
  const origin = request.headers.get("Origin") || "";
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (origin !== env.ALLOWED_ORIGIN || (fetchSite && fetchSite !== "same-origin")) {
    throw new HttpError(403, "This request is not allowed.");
  }
  return origin;
};

const handlePasswordChange = async (request: Request, env: Env): Promise<Response> => {
  const origin = requireAllowedOrigin(request, env);
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "The request format is not supported.");
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(request));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Enter the current and new passwords.");
  }
  if (!isObject(body) || typeof body.currentPassword !== "string" ||
      typeof body.newPassword !== "string" ||
      typeof body.confirmPassword !== "string" ||
      body.currentPassword.length < 1 || body.currentPassword.length > 256) {
    throw new HttpError(400, "Enter the current and new passwords.");
  }

  const requirementError = passwordRequirementError(body.newPassword);
  if (requirementError) throw new HttpError(400, requirementError);
  if (body.newPassword !== body.confirmPassword) {
    throw new HttpError(400, "The new passwords do not match.");
  }
  if (body.currentPassword === body.newPassword) {
    throw new HttpError(400, "Choose a password that is different from the current password.");
  }

  const current = await fetchRepositoryWorkbook(env);
  let dataKeyBytes: Uint8Array;
  try {
    dataKeyBytes = await unwrapDataKey(
      current.payload.encryption.access.password,
      body.currentPassword
    );
  } catch (error) {
    throw new HttpError(401, "The current password is incorrect.");
  }

  const iterations = Math.max(
    PBKDF2_ITERATIONS,
    current.payload.encryption.access.password.iterations
  );
  const password = await wrapDataKey(dataKeyBytes, body.newPassword, iterations);
  dataKeyBytes.fill(0);
  const nextPayload: WorkbookPayload = {
    ...current.payload,
    encryption: {
      ...current.payload.encryption,
      access: { password },
    },
  };
  await saveRepositoryWorkbook(env, nextPayload, current.sha);
  return jsonResponse(
    { ok: true, message: "Password updated. You can sign in with the new password now." },
    200,
    origin
  );
};

const handleOptions = (request: Request, env: Env): Response => {
  const origin = requireAllowedOrigin(request, env);
  const headers = securityHeaders();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  return new Response(null, { status: 204, headers });
};

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return handleOptions(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/workbook") {
        const current = await fetchRepositoryWorkbook(env);
        return jsonResponse(current.payload);
      }
      if (request.method === "POST" && url.pathname === "/api/admin/change-password") {
        return await handlePasswordChange(request, env);
      }
      return jsonResponse({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.publicMessage }, error.status);
      }
      console.error(JSON.stringify({
        message: "Admin API request failed",
        requestId,
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : "Unknown error",
      }));
      return jsonResponse({ error: "The password service is temporarily unavailable." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

export default handler;
export {
  passwordRequirementError,
  parseWorkbookPayload,
  unwrapDataKey,
  wrapDataKey,
};
