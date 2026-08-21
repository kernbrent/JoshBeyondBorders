import {
  HttpError,
  base64ToBytes,
  base64ToUtf8,
  isNonemptyString,
  isObject,
  utf8ToBase64,
} from "./shared";

const PBKDF2_ITERATIONS = 310_000;
const MAX_GITHUB_RESPONSE_BYTES = 8_000_000;
const MAX_ENCRYPTED_WORKBOOK_BYTES = 6_000_000;
const GITHUB_API_VERSION = "2026-03-10";
const EXCEL_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type PasswordAccess = {
  keyDerivation: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  wrappedKey: string;
};

export type DataKeyVerification = {
  algorithm: "SHA-256";
  digest: string;
};

export type WorkbookPayload = {
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
    keyVerification: DataKeyVerification;
    access: {
      password: PasswordAccess;
    };
  };
};

export type RepositoryWorkbook = {
  payload: WorkbookPayload;
  sha: string;
};

export type GivingPublishRequest = {
  dataKey: string;
  expectedRevision: string;
  file: WorkbookPayload["file"];
  data: WorkbookPayload["encryption"]["data"];
  raised: number;
};

export type PublishedGivingUpdate = {
  workbook: WorkbookPayload;
  revision: string;
  commitSha: string;
  progress: {
    version: 1;
    raised: number;
    goal: number;
    percent: number;
    updatedAt: string;
    sourceCell: "I2";
  };
};

export const isPasswordAccess = (value: unknown): value is PasswordAccess => {
  if (!isObject(value)) return false;
  if (value.keyDerivation !== "PBKDF2-SHA-256" ||
      typeof value.iterations !== "number" ||
      !Number.isInteger(value.iterations) ||
      value.iterations < 100_000 ||
      value.iterations > 2_000_000 ||
      !isNonemptyString(value.salt, 256) ||
      !isNonemptyString(value.iv, 256) ||
      !isNonemptyString(value.wrappedKey, 512)) {
    return false;
  }
  try {
    return base64ToBytes(value.salt).byteLength === 16 &&
      base64ToBytes(value.iv).byteLength === 12 &&
      base64ToBytes(value.wrappedKey).byteLength === 48;
  } catch (error) {
    return false;
  }
};

const isDataKeyVerification = (
  value: unknown
): value is DataKeyVerification => {
  if (!isObject(value) || value.algorithm !== "SHA-256" ||
      !isNonemptyString(value.digest, 128)) {
    return false;
  }
  try {
    return base64ToBytes(value.digest).byteLength === 32;
  } catch (error) {
    return false;
  }
};

export const parseWorkbookPayload = (value: unknown): WorkbookPayload => {
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
      !isNonemptyString(value.encryption.data.ciphertext, 8_000_000) ||
      !isDataKeyVerification(value.encryption.keyVerification) ||
      !isPasswordAccess(value.encryption.access.password)) {
    throw new HttpError(503, "The secure workbook format is unavailable.");
  }
  return value as WorkbookPayload;
};

export const verifyDataKey = async (
  encodedDataKey: string,
  verification: DataKeyVerification
): Promise<boolean> => {
  let dataKeyBytes: Uint8Array;
  try {
    dataKeyBytes = base64ToBytes(encodedDataKey);
  } catch (error) {
    return false;
  }
  try {
    if (dataKeyBytes.byteLength !== 32) return false;
    const expectedDigest = base64ToBytes(verification.digest);
    if (expectedDigest.byteLength !== 32) return false;
    const actualDigest = await crypto.subtle.digest("SHA-256", dataKeyBytes);
    return crypto.subtle.timingSafeEqual(actualDigest, expectedDigest);
  } catch (error) {
    return false;
  } finally {
    dataKeyBytes.fill(0);
  }
};

const githubHeaders = (env: Env): Headers => new Headers({
  "Accept": "application/vnd.github+json",
  "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
  "User-Agent": "JoshBeyondBorders-Admin-API",
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
});

const githubApiUrl = (env: Env, path: string): string =>
  `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/${path}`;

const encodeRepositoryPath = (path: string): string => path
  .split("/")
  .map((segment) => encodeURIComponent(segment))
  .join("/");

const githubContentsUrl = (env: Env): string =>
  githubApiUrl(env, `contents/${encodeRepositoryPath(env.WORKBOOK_PATH)}`);

const githubBranchPath = (branch: string): string => branch
  .split("/")
  .map((segment) => encodeURIComponent(segment))
  .join("/");

const readGithubJson = async (
  response: Response,
  publicMessage: string,
  maximumBytes = MAX_GITHUB_RESPONSE_BYTES
): Promise<unknown> => {
  if (!response.ok) throw new HttpError(503, publicMessage);
  const contentLength = Number(response.headers.get("Content-Length") || 0);
  if (contentLength > maximumBytes) throw new HttpError(503, publicMessage);
  return response.json();
};

export const fetchRepositoryWorkbook = async (
  env: Env
): Promise<RepositoryWorkbook> => {
  const url = new URL(githubContentsUrl(env));
  url.searchParams.set("ref", env.GITHUB_BRANCH);
  const result = await readGithubJson(
    await fetch(url, { headers: githubHeaders(env) }),
    "The secure workbook could not be loaded."
  );
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

export const savePasswordAccess = async (
  env: Env,
  current: RepositoryWorkbook,
  passwordAccess: PasswordAccess
): Promise<void> => {
  const nextPayload: WorkbookPayload = {
    ...current.payload,
    encryption: {
      ...current.payload.encryption,
      access: { password: passwordAccess },
    },
  };
  const headers = githubHeaders(env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  const response = await fetch(githubContentsUrl(env), {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: "Change Admin password",
      content: utf8ToBase64(`${JSON.stringify(nextPayload, null, 2)}\n`),
      sha: current.sha,
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

export const parseGivingPublishRequest = (
  value: unknown
): GivingPublishRequest => {
  if (!isObject(value) || !isObject(value.file) || !isObject(value.data) ||
      !isNonemptyString(value.dataKey, 128) ||
      !isNonemptyString(value.expectedRevision, 128) ||
      !isNonemptyString(value.file.name, 512) ||
      !isNonemptyString(value.file.type, 256) ||
      typeof value.file.size !== "number" ||
      !Number.isSafeInteger(value.file.size) || value.file.size < 1 ||
      value.file.size > MAX_ENCRYPTED_WORKBOOK_BYTES ||
      !isNonemptyString(value.data.iv, 256) ||
      !isNonemptyString(value.data.ciphertext, 8_000_000) ||
      typeof value.raised !== "number" || !Number.isFinite(value.raised) ||
      value.raised < 0 || value.raised > 100_000_000) {
    throw new HttpError(400, "The giving update is incomplete or invalid.");
  }
  if (!value.file.name.toLowerCase().endsWith(".xlsx") ||
      value.file.type !== EXCEL_CONTENT_TYPE) {
    throw new HttpError(400, "The giving update must contain an Excel workbook.");
  }
  try {
    const iv = base64ToBytes(value.data.iv);
    const ciphertext = base64ToBytes(value.data.ciphertext);
    if (iv.byteLength !== 12 || ciphertext.byteLength !== value.file.size + 16) {
      throw new Error("Invalid encrypted workbook size.");
    }
  } catch (error) {
    throw new HttpError(400, "The encrypted giving workbook is invalid.");
  }
  return value as GivingPublishRequest;
};

const githubWriteJson = async (
  env: Env,
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  publicMessage: string
): Promise<unknown> => {
  const headers = githubHeaders(env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  const response = await fetch(githubApiUrl(env, path), {
    method,
    headers,
    body: JSON.stringify(body),
  });
  if ((response.status === 409 || response.status === 422) && method === "PATCH") {
    throw new HttpError(409, "The giving report changed elsewhere. Reload and try again.");
  }
  return readGithubJson(response, publicMessage);
};

const createGithubBlob = async (
  env: Env,
  content: string
): Promise<string> => {
  const result = await githubWriteJson(
    env,
    "git/blobs",
    "POST",
    { content: utf8ToBase64(content), encoding: "base64" },
    "GitHub could not prepare the giving update."
  );
  if (!isObject(result) || !isNonemptyString(result.sha, 128)) {
    throw new HttpError(503, "GitHub returned an invalid giving update.");
  }
  return result.sha;
};

export const publishGivingUpdate = async (
  env: Env,
  current: RepositoryWorkbook,
  request: GivingPublishRequest
): Promise<PublishedGivingUpdate> => {
  if (request.expectedRevision !== current.sha) {
    throw new HttpError(409, "The giving report changed elsewhere. Reload and try again.");
  }
  const goal = Number(env.GIVING_GOAL);
  if (!Number.isFinite(goal) || goal <= 0) {
    throw new HttpError(503, "The giving goal is not configured.");
  }

  const roundedRaised = Math.round(request.raised * 100) / 100;
  const progress: PublishedGivingUpdate["progress"] = {
    version: 1,
    raised: roundedRaised,
    goal,
    percent: Math.round((roundedRaised / goal) * 10_000) / 100,
    updatedAt: new Date().toISOString(),
    sourceCell: "I2",
  };
  const workbook: WorkbookPayload = {
    ...current.payload,
    file: request.file,
    encryption: {
      ...current.payload.encryption,
      data: request.data,
    },
  };

  const branch = githubBranchPath(env.GITHUB_BRANCH);
  const branchRef = await readGithubJson(
    await fetch(githubApiUrl(env, `git/ref/heads/${branch}`), {
      headers: githubHeaders(env),
    }),
    "GitHub could not read the publishing branch."
  );
  if (!isObject(branchRef) || !isObject(branchRef.object) ||
      !isNonemptyString(branchRef.object.sha, 128)) {
    throw new HttpError(503, "GitHub returned an invalid publishing branch.");
  }
  const parentCommitSha = branchRef.object.sha;

  const parentCommit = await readGithubJson(
    await fetch(githubApiUrl(env, `git/commits/${encodeURIComponent(parentCommitSha)}`), {
      headers: githubHeaders(env),
    }),
    "GitHub could not read the current website version."
  );
  if (!isObject(parentCommit) || !isObject(parentCommit.tree) ||
      !isNonemptyString(parentCommit.tree.sha, 128)) {
    throw new HttpError(503, "GitHub returned an invalid website version.");
  }

  const workbookContent = `${JSON.stringify(workbook, null, 2)}\n`;
  const progressContent = `${JSON.stringify(progress, null, 2)}\n`;
  const [workbookBlobSha, progressBlobSha] = await Promise.all([
    createGithubBlob(env, workbookContent),
    createGithubBlob(env, progressContent),
  ]);

  const treeResult = await githubWriteJson(
    env,
    "git/trees",
    "POST",
    {
      base_tree: parentCommit.tree.sha,
      tree: [
        {
          path: env.WORKBOOK_PATH,
          mode: "100644",
          type: "blob",
          sha: workbookBlobSha,
        },
        {
          path: env.PROGRESS_PATH,
          mode: "100644",
          type: "blob",
          sha: progressBlobSha,
        },
      ],
    },
    "GitHub could not assemble the giving update."
  );
  if (!isObject(treeResult) || !isNonemptyString(treeResult.sha, 128)) {
    throw new HttpError(503, "GitHub returned an invalid giving update tree.");
  }

  const commitResult = await githubWriteJson(
    env,
    "git/commits",
    "POST",
    {
      message: "Sync PayPal donations and giving progress",
      tree: treeResult.sha,
      parents: [parentCommitSha],
    },
    "GitHub could not create the giving update."
  );
  if (!isObject(commitResult) || !isNonemptyString(commitResult.sha, 128)) {
    throw new HttpError(503, "GitHub returned an invalid giving update commit.");
  }

  await githubWriteJson(
    env,
    `git/refs/heads/${branch}`,
    "PATCH",
    { sha: commitResult.sha, force: false },
    "GitHub could not publish the giving update."
  );

  return {
    workbook,
    revision: workbookBlobSha,
    commitSha: commitResult.sha,
    progress,
  };
};

export const minimumPasswordIterations = (
  current: WorkbookPayload
): number => Math.max(
  PBKDF2_ITERATIONS,
  current.encryption.access.password.iterations
);
