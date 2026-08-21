import { fetchPayPalDonations } from "./paypal";
import {
  minimumPasswordIterations,
  fetchRepositoryWorkbook,
  isPasswordAccess,
  parseGivingPublishRequest,
  publishGivingUpdate,
  savePasswordAccess,
  verifyDataKey,
} from "./workbook-repository";
import {
  HttpError,
  isObject,
  jsonResponse,
  optionsResponse,
  parseJsonRequest,
  requireAllowedOrigin,
} from "./shared";

const SMALL_REQUEST_BYTES = 4_096;
const PUBLISH_REQUEST_BYTES = 8_000_000;

const requireVerifiedWorkbook = async (
  env: Env,
  encodedDataKey: string
) => {
  const current = await fetchRepositoryWorkbook(env);
  const dataKeyMatches = await verifyDataKey(
    encodedDataKey,
    current.payload.encryption.keyVerification
  );
  if (!dataKeyMatches) {
    throw new HttpError(401, "Your secure sign-in has expired. Sign in again and retry.");
  }
  return current;
};

const handlePasswordChange = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const origin = requireAllowedOrigin(request, env);
  const body = await parseJsonRequest(
    request,
    SMALL_REQUEST_BYTES,
    "Sign in again, then enter the new password."
  );
  if (!isObject(body) || typeof body.dataKey !== "string" ||
      !isPasswordAccess(body.passwordAccess) ||
      body.dataKey.length < 1 || body.dataKey.length > 128) {
    throw new HttpError(400, "Sign in again, then enter the new password.");
  }

  const current = await requireVerifiedWorkbook(env, body.dataKey);
  if (body.passwordAccess.iterations < minimumPasswordIterations(current.payload)) {
    throw new HttpError(400, "The new password protection is not strong enough.");
  }
  await savePasswordAccess(env, current, body.passwordAccess);
  return jsonResponse(
    { ok: true, message: "Password updated. You can sign in with the new password now." },
    200,
    origin
  );
};

const handlePayPalDonations = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const origin = requireAllowedOrigin(request, env);
  const body = await parseJsonRequest(
    request,
    SMALL_REQUEST_BYTES,
    "Sign in again before syncing PayPal donations."
  );
  if (!isObject(body) || typeof body.dataKey !== "string" ||
      body.dataKey.length < 1 || body.dataKey.length > 128) {
    throw new HttpError(400, "Sign in again before syncing PayPal donations.");
  }
  await requireVerifiedWorkbook(env, body.dataKey);
  const result = await fetchPayPalDonations(env);
  return jsonResponse({ ...result }, 200, origin);
};

const handleGivingPublish = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const origin = requireAllowedOrigin(request, env);
  const body = parseGivingPublishRequest(await parseJsonRequest(
    request,
    PUBLISH_REQUEST_BYTES,
    "The giving update could not be read."
  ));
  const current = await requireVerifiedWorkbook(env, body.dataKey);
  const published = await publishGivingUpdate(env, current, body);
  return jsonResponse({
    ok: true,
    message: "PayPal donations and giving progress were published successfully.",
    revision: published.revision,
    commitSha: published.commitSha,
    progress: published.progress,
  }, 200, origin);
};

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return optionsResponse(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/workbook") {
        const current = await fetchRepositoryWorkbook(env);
        return jsonResponse(
          { ...current.payload },
          200,
          "",
          {
            "ETag": `\"${current.sha}\"`,
            "X-Workbook-Revision": current.sha,
          }
        );
      }
      if (request.method === "POST" && url.pathname === "/api/admin/change-password") {
        return await handlePasswordChange(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/admin/paypal-donations") {
        return await handlePayPalDonations(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/admin/publish-giving") {
        return await handleGivingPublish(request, env);
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
      return jsonResponse({ error: "The Admin service is temporarily unavailable." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

export default handler;
export {
  parseWorkbookPayload,
  verifyDataKey,
} from "./workbook-repository";
export { normalizeDonation } from "./paypal";
