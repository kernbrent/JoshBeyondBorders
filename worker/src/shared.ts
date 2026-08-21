export type JsonObject = Record<string, unknown>;

export class HttpError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isNonemptyString = (
  value: unknown,
  maximum = 200_000
): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

export const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

export const utf8ToBase64 = (value: string): string =>
  bytesToBase64(new TextEncoder().encode(value));

export const base64ToUtf8 = (value: string): string =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
    .decode(base64ToBytes(value));

const securityHeaders = (): Headers => new Headers({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export const jsonResponse = (
  body: JsonObject,
  status = 200,
  origin = "",
  additionalHeaders: Record<string, string> = {}
): Response => {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  for (const [name, value] of Object.entries(additionalHeaders)) {
    headers.set(name, value);
  }
  return Response.json(body, { status, headers });
};

export const readBoundedText = async (
  request: Request,
  maximumBytes: number
): Promise<string> => {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
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

export const parseJsonRequest = async (
  request: Request,
  maximumBytes: number,
  publicMessage: string
): Promise<unknown> => {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "The request format is not supported.");
  }
  try {
    return JSON.parse(await readBoundedText(request, maximumBytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, publicMessage);
  }
};

export const requireAllowedOrigin = (request: Request, env: Env): string => {
  const origin = request.headers.get("Origin") || "";
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (origin !== env.ALLOWED_ORIGIN || (fetchSite && fetchSite !== "same-origin")) {
    throw new HttpError(403, "This request is not allowed.");
  }
  return origin;
};

export const optionsResponse = (request: Request, env: Env): Response => {
  const origin = requireAllowedOrigin(request, env);
  const headers = securityHeaders();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  return new Response(null, { status: 204, headers });
};
