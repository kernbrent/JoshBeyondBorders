"use strict";

const IS_LOCAL_PREVIEW = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const STATIC_ENCRYPTED_WORKBOOK_URL = "resources/giving-workbook.enc.json";
const ENCRYPTED_WORKBOOK_URL = IS_LOCAL_PREVIEW
  ? STATIC_ENCRYPTED_WORKBOOK_URL
  : "/api/admin/workbook";
const PASSWORD_CHANGE_URL = "/api/admin/change-password";
const PAYPAL_DONATIONS_URL = "/api/admin/paypal-donations";
const GIVING_PUBLISH_URL = "/api/admin/publish-giving";
const CSM_INBOX_LIST_URL = "/api/admin/csm-inbox/list";
const CSM_GIVING_URL = "/api/admin/csm-giving";
const PBKDF2_ITERATIONS = 310000;
const GIVING_GOAL = 7500;
const EXCEL_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const REMEMBERED_PASSWORD_DATABASE = "josh-beyond-borders-admin";
const REMEMBERED_PASSWORD_STORE = "device-secrets";
const REMEMBERED_PASSWORD_KEY_ID = "remembered-password-key";
const REMEMBERED_PASSWORD_RECORD_ID = "remembered-admin-password";

function preventDialogBackdropDismissal() {
  document.querySelectorAll("dialog").forEach(dialog => dialog.setAttribute("closedby", "closerequest"));
  document.addEventListener("click", event => {
    if (!(event.target instanceof HTMLDialogElement) || !event.target.open) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

preventDialogBackdropDismissal();

const loginPanel = document.querySelector("#login-panel");
const resourcesPanel = document.querySelector("#resources-panel");
const donorStatementsPanel = document.querySelector("#donor-statements-panel");
const loginForm = document.querySelector("#admin-login-form");
const loginStatus = document.querySelector("#login-status");
const adminPassword = document.querySelector("#admin-password");
const rememberAdminPassword = document.querySelector("#remember-admin-password");
const passwordChangePanel = document.querySelector("#password-change-panel");
const passwordChangeForm = document.querySelector("#password-change-form");
const currentAdminPassword = document.querySelector("#current-admin-password");
const newAdminPassword = document.querySelector("#new-admin-password");
const confirmAdminPassword = document.querySelector("#confirm-admin-password");
const cancelPasswordChangeButton = document.querySelector("#cancel-password-change");
const passwordChangeStatus = document.querySelector("#password-change-status");
const signoutButton = document.querySelector("#admin-signout");
const resourcesPasswordChangeButton = document.querySelector("#resources-password-change");
const openDonorStatementsButton = document.querySelector("#open-donor-statements");
const returnToResourcesButton = document.querySelector("#return-to-resources");
const donorStatementsSignoutButton = document.querySelector("#donor-statements-signout");
const workbookDownload = document.querySelector("#workbook-download");
const workbookSource = document.querySelector("#workbook-source");
const prepareUpdate = document.querySelector("#prepare-update");
const publisherStatus = document.querySelector("#publisher-status");
const publisherDownloads = document.querySelector("#publisher-downloads");
const progressDownload = document.querySelector("#progress-download");
const encryptedDownload = document.querySelector("#encrypted-download");
const paypalPaidDate = document.querySelector("#paypal-paid-date");
const syncPayPalButton = document.querySelector("#sync-paypal-donations");
const paypalSyncStatus = document.querySelector("#paypal-sync-status");
const csmInboxList = document.querySelector("#csm-inbox-list");
const csmInboxStatus = document.querySelector("#csm-inbox-status");
const csmInboxFilter = document.querySelector("#csm-inbox-filter");
const csmInboxBadge = document.querySelector("#csm-inbox-badge");
const refreshCsmInboxButton = document.querySelector("#refresh-csm-inbox");
const approveAllCsmInboxButton = document.querySelector("#approve-all-csm-inbox");
const openCsmDonorsButton = document.querySelector("#open-csm-donors");
const csmGivingYear = document.querySelector("#csm-giving-year");
const csmGrossReceived = document.querySelector("#csm-gross-received");
const csmNetReceived = document.querySelector("#csm-net-received");
const csmDonationCount = document.querySelector("#csm-donation-count");
const csmGiverCount = document.querySelector("#csm-giver-count");
const csmSentTotal = document.querySelector("#csm-sent-total");
const passwordVisibilityButtons = document.querySelectorAll("[data-password-toggle]");
let activePassword = "";
let activePayload = null;
let activeDataKeyBytes = null;
let activeWorkbookBytes = null;
let activeRevision = "";
let workbookObjectUrl = "";
let updateObjectUrls = [];
let rememberPasswordForFuture = false;
let legacyDonorIndex = [];

const setPasswordVisibility = (button, visible) => {
  const field = document.getElementById(button.dataset.passwordToggle);
  if (!field) return;
  const label = button.dataset.passwordLabel || "password";
  const action = visible ? "Hide" : "Show";
  field.type = visible ? "text" : "password";
  button.setAttribute("aria-pressed", String(visible));
  button.setAttribute("aria-label", `${action} ${label}`);
  button.title = `${action} ${label}`;
};

const resetPasswordVisibility = () => {
  passwordVisibilityButtons.forEach((button) => {
    setPasswordVisibility(button, false);
  });
};

const setStatus = (element, message, kind = "error") => {
  element.textContent = message;
  if (message) element.dataset.kind = kind;
  else element.removeAttribute("data-kind");
};

const bytesToBase64 = (bytes) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
};

const base64ToBytes = (value) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const openRememberedPasswordDatabase = () => new Promise((resolve, reject) => {
  if (!window.indexedDB) {
    reject(new Error("Remembered passwords are unavailable in this browser."));
    return;
  }
  const request = indexedDB.open(REMEMBERED_PASSWORD_DATABASE, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(REMEMBERED_PASSWORD_STORE)) {
      database.createObjectStore(REMEMBERED_PASSWORD_STORE);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("Browser storage is unavailable."));
  request.onblocked = () => reject(new Error("Browser storage is temporarily blocked."));
});

const runRememberedPasswordTransaction = async (mode, operation) => {
  const database = await openRememberedPasswordDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(REMEMBERED_PASSWORD_STORE, mode);
      const store = transaction.objectStore(REMEMBERED_PASSWORD_STORE);
      let result;
      let request;
      try {
        request = operation(store);
      } catch (error) {
        transaction.abort();
        reject(error);
        return;
      }
      if (request) {
        request.onsuccess = () => {
          result = request.result;
        };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(
        transaction.error || new Error("Browser storage could not be updated.")
      );
      transaction.onabort = () => reject(
        transaction.error || new Error("Browser storage was interrupted.")
      );
    });
  } finally {
    database.close();
  }
};

const readRememberedPasswordValue = (identifier) =>
  runRememberedPasswordTransaction("readonly", (store) => store.get(identifier));

const writeRememberedPasswordValue = (identifier, value) =>
  runRememberedPasswordTransaction("readwrite", (store) => store.put(value, identifier));

const clearRememberedPassword = () =>
  runRememberedPasswordTransaction("readwrite", (store) => {
    store.delete(REMEMBERED_PASSWORD_KEY_ID);
    return store.delete(REMEMBERED_PASSWORD_RECORD_ID);
  });

const isRememberedPasswordKey = (value) => Boolean(
  value &&
  value.type === "secret" &&
  value.algorithm?.name === "AES-GCM" &&
  value.usages?.includes("encrypt") &&
  value.usages?.includes("decrypt")
);

const getRememberedPasswordKey = async () => {
  const savedKey = await readRememberedPasswordValue(REMEMBERED_PASSWORD_KEY_ID);
  if (isRememberedPasswordKey(savedKey)) return savedKey;
  const deviceKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  await writeRememberedPasswordValue(REMEMBERED_PASSWORD_KEY_ID, deviceKey);
  return deviceKey;
};

const saveRememberedPassword = async (password) => {
  const deviceKey = await getRememberedPasswordKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const passwordBytes = new TextEncoder().encode(password);
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      deviceKey,
      passwordBytes
    );
    await writeRememberedPasswordValue(REMEMBERED_PASSWORD_RECORD_ID, {
      version: 1,
      iv,
      ciphertext,
    });
  } finally {
    passwordBytes.fill(0);
  }
};

const loadRememberedPassword = async () => {
  const [deviceKey, record] = await Promise.all([
    readRememberedPasswordValue(REMEMBERED_PASSWORD_KEY_ID),
    readRememberedPasswordValue(REMEMBERED_PASSWORD_RECORD_ID),
  ]);
  if (!isRememberedPasswordKey(deviceKey) || record?.version !== 1 ||
      !(record.iv instanceof Uint8Array) || !(record.ciphertext instanceof ArrayBuffer)) {
    return "";
  }
  const clearBytes = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: record.iv },
    deviceKey,
    record.ciphertext
  ));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(clearBytes);
  } finally {
    clearBytes.fill(0);
  }
};

const restoreRememberedPassword = async () => {
  try {
    const savedPassword = await loadRememberedPassword();
    const hasSavedPassword = Boolean(savedPassword);
    rememberAdminPassword.checked = hasSavedPassword;
    rememberPasswordForFuture = hasSavedPassword;
    if (hasSavedPassword && !adminPassword.value) {
      adminPassword.value = savedPassword;
    }
  } catch (error) {
    rememberAdminPassword.checked = false;
    rememberPasswordForFuture = false;
    try {
      await clearRememberedPassword();
    } catch (clearError) {
      // The login remains usable when browser storage is unavailable.
    }
  }
};

const deriveWorkbookKey = async (password, salt, iterations, usages) => {
  const passwordMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    passwordMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
};

const passwordRequirementError = (value) => {
  const meetsRequirements = value.length >= 8 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value) &&
    /[^A-Za-z0-9\s]/.test(value);
  return meetsRequirements
    ? ""
    : "Use at least 8 characters with a lowercase letter, an uppercase letter, a number, and a special character.";
};

const importDataKey = (bytes, usages) =>
  crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usages);

const unwrapDataKey = async (access, secret) => {
  const salt = base64ToBytes(access.salt);
  const iv = base64ToBytes(access.iv);
  const wrappingKey = await deriveWorkbookKey(
    secret,
    salt,
    access.iterations,
    ["decrypt"]
  );
  const clearKey = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    base64ToBytes(access.wrappedKey)
  );
  return new Uint8Array(clearKey);
};

const wrapDataKey = async (dataKeyBytes, secret, iterations) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveWorkbookKey(
    secret,
    salt,
    iterations,
    ["encrypt"]
  );
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    dataKeyBytes
  );
  return {
    keyDerivation: "PBKDF2-SHA-256",
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    wrappedKey: bytesToBase64(new Uint8Array(wrappedKey)),
  };
};

const loadEncryptedWorkbookFrom = async (url) => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("The encrypted workbook is unavailable.");
  const payload = await response.json();
  const isLegacy = payload.version === 1 && payload.encryption?.algorithm === "AES-256-GCM";
  const isRecoverable = payload.version === 2 &&
    payload.encryption?.algorithm === "AES-256-GCM-ENVELOPE";
  if (!isLegacy && !isRecoverable) {
    throw new Error("The encrypted workbook format is not supported.");
  }
  return {
    payload,
    revision: response.headers.get("X-Workbook-Revision") || "",
  };
};

const loadEncryptedWorkbook = async () => {
  try {
    return await loadEncryptedWorkbookFrom(ENCRYPTED_WORKBOOK_URL);
  } catch (error) {
    if (!IS_LOCAL_PREVIEW) {
      return loadEncryptedWorkbookFrom(STATIC_ENCRYPTED_WORKBOOK_URL);
    }
    throw error;
  }
};

const decryptWorkbook = async (payload, password) => {
  if (payload.version === 1) {
    const salt = base64ToBytes(payload.encryption.salt);
    const iv = base64ToBytes(payload.encryption.iv);
    const key = await deriveWorkbookKey(
      password,
      salt,
      payload.encryption.iterations,
      ["decrypt"]
    );
    const clearBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      base64ToBytes(payload.encryption.ciphertext)
    );
    return { bytes: clearBytes, file: payload.file, dataKeyBytes: null };
  }

  const access = payload.encryption.access?.password;
  if (!access) throw new Error("Password access is unavailable.");
  const dataKeyBytes = await unwrapDataKey(access, password);
  const dataKey = await importDataKey(dataKeyBytes, ["decrypt"]);
  const clearBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.encryption.data.iv) },
    dataKey,
    base64ToBytes(payload.encryption.data.ciphertext)
  );
  return { bytes: clearBytes, file: payload.file, dataKeyBytes };
};

const clearWorkbookDownload = () => {
  if (workbookObjectUrl) URL.revokeObjectURL(workbookObjectUrl);
  workbookObjectUrl = "";
  workbookDownload.removeAttribute("href");
  workbookDownload.removeAttribute("download");
};

const clearUpdateDownloads = () => {
  updateObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  updateObjectUrls = [];
  progressDownload.removeAttribute("href");
  encryptedDownload.removeAttribute("href");
  publisherDownloads.hidden = true;
};

const clearActiveCredentials = () => {
  if (activeDataKeyBytes) activeDataKeyBytes.fill(0);
  if (activeWorkbookBytes) new Uint8Array(activeWorkbookBytes).fill(0);
  activePassword = "";
  activePayload = null;
  activeDataKeyBytes = null;
  activeWorkbookBytes = null;
  activeRevision = "";
  legacyDonorIndex = [];
  csmInboxList?.replaceChildren();
};

const refreshWorkbookDownload = (bytes, file) => {
  clearWorkbookDownload();
  const type = file.type || EXCEL_CONTENT_TYPE;
  workbookObjectUrl = URL.createObjectURL(new Blob([bytes], { type }));
  workbookDownload.href = workbookObjectUrl;
  workbookDownload.download = file.name;
};

const showResources = (decrypted) => {
  activeDataKeyBytes = decrypted.dataKeyBytes;
  activeWorkbookBytes = decrypted.bytes.slice(0);
  refreshWorkbookDownload(activeWorkbookBytes, decrypted.file);
  loginPanel.hidden = true;
  donorStatementsPanel.hidden = true;
  resourcesPanel.hidden = false;
  syncPayPalButton.disabled = IS_LOCAL_PREVIEW || !activeRevision;
  if (IS_LOCAL_PREVIEW) {
    setStatus(
      paypalSyncStatus,
      "PayPal sync runs only on the live Admin page. Local preview remains read-only."
    );
  }
  signoutButton.focus();
  void initializeCsmInbox();
};

const showLogin = () => {
  clearActiveCredentials();
  clearWorkbookDownload();
  clearUpdateDownloads();
  window.JBBDonorStatements?.clear();
  resourcesPanel.hidden = true;
  donorStatementsPanel.hidden = true;
  passwordChangePanel.hidden = true;
  loginPanel.hidden = false;
  loginForm.reset();
  workbookSource.value = "";
  passwordChangeForm.reset();
  resetPasswordVisibility();
  currentAdminPassword.readOnly = false;
  prepareUpdate.disabled = true;
  setStatus(loginStatus, "");
  setStatus(publisherStatus, "");
  setStatus(paypalSyncStatus, "");
  setStatus(passwordChangeStatus, "");
  syncPayPalButton.disabled = true;
  adminPassword.focus();
  void restoreRememberedPassword();
};

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = adminPassword.value;
  const submitButton = loginForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  setStatus(loginStatus, "Opening encrypted resources...", "success");
  try {
    const loaded = await loadEncryptedWorkbook();
    const decrypted = await decryptWorkbook(loaded.payload, password);
    rememberPasswordForFuture = rememberAdminPassword.checked;
    try {
      if (rememberPasswordForFuture) {
        await saveRememberedPassword(password);
      } else {
        await clearRememberedPassword();
      }
    } catch (storageError) {
      rememberAdminPassword.checked = false;
      rememberPasswordForFuture = false;
    }
    activePassword = password;
    activePayload = loaded.payload;
    activeRevision = loaded.revision;
    adminPassword.value = "";
    setStatus(loginStatus, "");
    showResources(decrypted);
  } catch (error) {
    setStatus(loginStatus, "The password is incorrect or the secure workbook could not be opened.");
    adminPassword.select();
  } finally {
    submitButton.disabled = false;
  }
});

rememberAdminPassword.addEventListener("change", () => {
  rememberPasswordForFuture = rememberAdminPassword.checked;
  if (!rememberPasswordForFuture) {
    void clearRememberedPassword().catch(() => {
      // The option is still disabled even if browser storage cannot be reached.
    });
  }
});

signoutButton.addEventListener("click", showLogin);
donorStatementsSignoutButton.addEventListener("click", showLogin);

const showDonorStatements = async () => {
  if (!activeWorkbookBytes) {
    showLogin();
    setStatus(loginStatus, "Sign in before opening donor giving statements.");
    return;
  }
  if (!window.JBBDonorStatements?.open) {
    setStatus(
      paypalSyncStatus,
      "The donor statement tools did not load. Refresh the page and try again."
    );
    return;
  }
  let approvedGifts = [];
  if (!IS_LOCAL_PREVIEW) {
    try {
      setStatus(csmInboxStatus, "Loading approved donor records...", "success");
      const result = await csmPost(CSM_GIVING_URL);
      approvedGifts = Array.isArray(result.gifts) ? result.gifts : [];
    } catch (error) {
      setStatus(csmInboxStatus, error.message || "Approved donor records could not be loaded.");
      return;
    }
  }
  loginPanel.hidden = true;
  passwordChangePanel.hidden = true;
  resourcesPanel.hidden = true;
  donorStatementsPanel.hidden = false;
  void window.JBBDonorStatements.open(activeWorkbookBytes, approvedGifts);
};

const returnToResources = () => {
  window.JBBDonorStatements?.clear();
  donorStatementsPanel.hidden = true;
  resourcesPanel.hidden = false;
  signoutButton.focus();
  void initializeCsmInbox();
};

openDonorStatementsButton.addEventListener("click", showDonorStatements);
openCsmDonorsButton?.addEventListener("click", showDonorStatements);
returnToResourcesButton.addEventListener("click", returnToResources);

const showPasswordChange = () => {
  const hasVerifiedSession = Boolean(
    activePassword &&
    activeDataKeyBytes &&
    activePayload?.version === 2
  );
  if (!hasVerifiedSession) {
    showLogin();
    setStatus(loginStatus, "Sign in before changing the Admin password.");
    return;
  }
  loginPanel.hidden = true;
  window.JBBDonorStatements?.clear();
  donorStatementsPanel.hidden = true;
  resourcesPanel.hidden = true;
  passwordChangePanel.hidden = false;
  passwordChangeForm.reset();
  resetPasswordVisibility();
  currentAdminPassword.readOnly = true;
  currentAdminPassword.value = activePassword;
  setStatus(passwordChangeStatus, "");
  newAdminPassword.focus();
};

resourcesPasswordChangeButton.addEventListener("click", showPasswordChange);
cancelPasswordChangeButton.addEventListener("click", showLogin);

workbookSource.addEventListener("change", () => {
  clearUpdateDownloads();
  setStatus(publisherStatus, "");
  prepareUpdate.disabled = !workbookSource.files?.length;
});

const findZipDirectory = (arrayBuffer) => {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const minimumOffset = Math.max(0, bytes.length - 65557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("This file is not a readable Excel workbook.");

  const entryCount = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("The Excel workbook directory is damaged.");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("The Excel workbook contains a damaged file entry.");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, {
      method,
      bytes: bytes.subarray(dataOffset, dataOffset + compressedSize),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const readZipEntry = async (entries, name) => {
  const entry = entries.get(name);
  if (!entry) throw new Error(`The workbook is missing ${name}.`);
  if (entry.method === 0) return entry.bytes;
  if (entry.method !== 8 || typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot unpack the selected Excel workbook.");
  }
  const stream = new Blob([entry.bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const parseXml = (source) => {
  const documentNode = new DOMParser().parseFromString(source, "application/xml");
  if (documentNode.querySelector("parsererror")) {
    throw new Error("The selected workbook contains invalid XML.");
  }
  return documentNode;
};

const elementsNamed = (node, localName) =>
  Array.from(node.getElementsByTagNameNS("*", localName));

const findYellowTotal = async (arrayBuffer) => {
  const entries = findZipDirectory(arrayBuffer);
  const decoder = new TextDecoder();
  const stylesSource = decoder.decode(await readZipEntry(entries, "xl/styles.xml"));
  const styles = parseXml(stylesSource);
  const fillsContainer = elementsNamed(styles, "fills")[0];
  const cellFormats = elementsNamed(styles, "cellXfs")[0];
  if (!fillsContainer || !cellFormats) {
    throw new Error("The workbook does not contain the expected formatting information.");
  }

  const fills = Array.from(fillsContainer.children).filter((node) => node.localName === "fill");
  const yellowFillIds = new Set();
  fills.forEach((fill, index) => {
    const foreground = elementsNamed(fill, "fgColor")[0];
    const rgb = foreground?.getAttribute("rgb")?.toUpperCase() || "";
    const indexed = foreground?.getAttribute("indexed") || "";
    if (rgb.endsWith("FFFF00") || indexed === "6") yellowFillIds.add(index);
  });

  const yellowStyleIds = new Set();
  Array.from(cellFormats.children)
    .filter((node) => node.localName === "xf")
    .forEach((format, index) => {
      if (yellowFillIds.has(Number(format.getAttribute("fillId")))) {
        yellowStyleIds.add(index);
      }
    });

  const worksheetNames = Array.from(entries.keys())
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const matches = [];
  for (const worksheetName of worksheetNames) {
    const worksheetSource = decoder.decode(await readZipEntry(entries, worksheetName));
    const worksheet = parseXml(worksheetSource);
    elementsNamed(worksheet, "c").forEach((cell) => {
      const reference = cell.getAttribute("r") || "";
      const styleId = Number(cell.getAttribute("s") || 0);
      if (!/^I\d+$/i.test(reference) || !yellowStyleIds.has(styleId)) return;
      const valueNode = elementsNamed(cell, "v")[0];
      const value = Number(valueNode?.textContent);
      if (Number.isFinite(value)) matches.push({ cell: reference.toUpperCase(), value });
    });
  }

  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? "More than one yellow gross total was found in column I. Keep only the fundraising total highlighted yellow."
        : "No yellow numeric gross total was found in column I."
    );
  }
  return matches[0];
};

const fileRecord = (file, byteLength) => ({
  name: file.name,
  type: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: Number(file.size) || byteLength,
});

const encryptWorkbookData = async (arrayBuffer, dataKeyBytes) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dataKey = await importDataKey(dataKeyBytes, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, arrayBuffer);
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
};

const updateSecureWorkbook = async (arrayBuffer, file) => {
  if (!activePayload || activePayload.version !== 2 || !activeDataKeyBytes) {
    throw new Error("Sign out and sign in again before publishing a new report.");
  }
  const data = await encryptWorkbookData(arrayBuffer, activeDataKeyBytes);
  return {
    ...activePayload,
    file: fileRecord(file, arrayBuffer.byteLength),
    encryption: { ...activePayload.encryption, data },
  };
};

const postAdminJson = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let result = {};
  try {
    result = await response.json();
  } catch (error) {
    // The caller reports a friendly service error for non-JSON responses.
  }
  if (!response.ok) {
    throw new Error(result.error || "The protected Admin service is unavailable.");
  }
  return result;
};

const csmPost = async (url, body = {}) => {
  if (!activeDataKeyBytes) throw new Error("Your secure sign-in has expired. Sign in again and retry.");
  return postAdminJson(url, { dataKey: bytesToBase64(activeDataKeyBytes), ...body });
};

const csmMoney = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0));
const csmDate = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value || "") : parsed.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
};
const csmTitle = (value) => String(value || "").replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
const csmElement = (tag, className, textContent) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
};
const csmMeta = (label, value) => {
  const item = csmElement("div");
  item.append(csmElement("span", "", label), csmElement("strong", "", value || "Not provided"));
  return item;
};
const csmInput = (labelText, name, value) => {
  const label = csmElement("label");
  label.append(csmElement("span", "", labelText));
  const input = document.createElement("input");
  input.name = name;
  input.value = value || "";
  label.append(input);
  return label;
};
const csmNameParts = (displayName) => {
  const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts.shift() || "", lastName: parts.join(" ") };
};
const legacyWorkbookMatch = (message) => {
  const email = String(message.party?.email || "").trim().toLowerCase();
  if (!email) return null;
  const matches = legacyDonorIndex.filter(donor => donor.email === email);
  return matches.length === 1 ? matches[0] : null;
};

const csmApprovalBody = (message) => {
  if (message.direction !== "received") return {};
  if (message.matchedDonor?.id) return { donorId: message.matchedDonor.id };
  const names = csmNameParts(message.displayName);
  return {
    donor: {
      displayName: message.displayName,
      firstName: names.firstName,
      lastName: names.lastName,
      email: message.party.email,
      phone: message.party.phone,
    },
  };
};

const renderCsmGivingSummary = (summary = {}) => {
  const year = Number(summary.year) || new Date().getFullYear();
  csmGivingYear.textContent = `${year} gross received`;
  csmGrossReceived.textContent = csmMoney(summary.grossReceived);
  csmNetReceived.textContent = csmMoney(summary.netReceived);
  csmDonationCount.textContent = String(Number(summary.donations || 0));
  csmGiverCount.textContent = String(Number(summary.givers || 0));
  csmSentTotal.textContent = csmMoney(summary.sent);
};

const renderCsmInboxCard = (message) => {
  const card = csmElement("article", "csm-inbox__card");
  const header = csmElement("header");
  const heading = csmElement("div");
  heading.append(csmElement("h4", "", message.displayName), csmElement("span", "", `${csmTitle(message.direction)} · ${csmDate(message.receivedAt)}`));
  header.append(heading, csmElement("span", "csm-inbox__pill", csmTitle(message.status)), csmElement("span", "csm-inbox__amount", csmMoney(message.transaction.gross)));
  const meta = csmElement("div", "csm-inbox__meta");
  meta.append(
    csmMeta("Display Name", message.displayName),
    csmMeta("PayPal date", csmDate(message.transaction.eventDate)),
    csmMeta("Item", message.transaction.itemName || message.transaction.itemId || "No item supplied"),
    csmMeta("Email", message.party.email || "Not supplied"),
  );
  card.append(header, meta);
  const legacyMatch = legacyWorkbookMatch(message);

  if (["pending", "needs_match", "failed"].includes(message.status)) {
    const form = csmElement("form", "csm-inbox__review");
    let donorSelect = null;
    if (message.direction === "received") {
      const donors = new Map();
      if (message.matchedDonor) donors.set(message.matchedDonor.id, message.matchedDonor);
      (message.candidates || []).forEach(donor => donors.set(donor.id, {
        id: donor.id, displayName: donor.display_name, email: donor.email,
      }));
      if (donors.size) {
        const label = csmElement("label", "csm-inbox__donor-select");
        label.append(csmElement("span", "", "Existing JBB donor"));
        donorSelect = document.createElement("select");
        const create = csmElement("option", "", "Create a linked donor record");
        create.value = "";
        donorSelect.append(create);
        for (const donor of donors.values()) {
          const option = csmElement("option", "", `${donor.displayName} · ${donor.email || "No email"}`);
          option.value = donor.id;
          option.selected = donor.id === message.matchedDonor?.id;
          donorSelect.append(option);
        }
        label.append(donorSelect);
        form.append(label);
      }
      const names = csmNameParts(message.displayName);
      form.append(
        csmInput("Display Name", "displayName", message.displayName),
        csmInput("First name", "firstName", names.firstName),
        csmInput("Last name", "lastName", names.lastName),
        csmInput("Email", "email", message.party.email),
      );
    }
    const approve = csmElement("button", "admin-submit", message.direction === "received" ? "Approve gift" : "Approve sent payment");
    approve.type = "submit";
    form.append(approve);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      approve.disabled = true;
      setStatus(csmInboxStatus, "Approving transaction...", "success");
      try {
        const values = new FormData(form);
        const donorId = donorSelect?.value || "";
        const body = donorId ? { donorId } : message.direction === "received" ? {
          donor: {
            displayName: values.get("displayName"), firstName: values.get("firstName"),
            lastName: values.get("lastName"), email: values.get("email"), phone: message.party.phone,
          },
        } : {};
        const result = await csmPost(`/api/admin/csm-inbox/${message.id}/approve`, body);
        await loadCsmInbox();
        setStatus(csmInboxStatus, `${message.displayName} was approved.${result.createdDonor
          ? " A new donor record was added to Donor Giving Statements." : ""}`, "success");
      } catch (error) {
        setStatus(csmInboxStatus, error.message || "The transaction could not be approved.");
      } finally {
        approve.disabled = false;
      }
    });
    card.append(form);

    const actions = csmElement("div", "csm-inbox__actions");
    const note = message.matchedDonor
      ? `Matched to ${message.matchedDonor.displayName} by ${csmTitle(message.matchMethod)}.`
      : legacyMatch
        ? `Exact email match found locally in the encrypted workbook for ${legacyMatch.displayName}. Approval creates its linked D1 directory record.`
        : message.direction === "received" ? "Review the proposed donor before approval." : "Sent payments never create donor records.";
    actions.append(csmElement("span", message.status === "needs_match" ? "csm-inbox__warning" : "", note));
    const deny = csmElement("button", "admin-signout", "Deny");
    deny.type = "button";
    deny.addEventListener("click", async () => {
      const reason = window.prompt("Why should this transaction be denied?");
      if (!reason?.trim()) return;
      deny.disabled = true;
      try { await csmPost(`/api/admin/csm-inbox/${message.id}/deny`, { reason }); await loadCsmInbox(); }
      catch (error) { setStatus(csmInboxStatus, error.message || "The transaction could not be denied."); }
      finally { deny.disabled = false; }
    });
    actions.append(deny);
    card.append(actions);
  } else {
    card.append(csmElement("p", "", message.status === "approved"
      ? `Approved into the JBB ledger${message.matchedDonor ? ` for ${message.matchedDonor.displayName}` : ""}.`
      : `Denied: ${message.decisionReason || "No reason recorded"}`));
  }

  if (message.callbackStatus === "failed") {
    const callback = csmElement("div", "csm-inbox__actions");
    callback.append(csmElement("span", "csm-inbox__warning", `CSM status update needs retry: ${message.callbackError || "Unknown error"}`));
    const retry = csmElement("button", "admin-signout", "Retry CSM update");
    retry.type = "button";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try { await csmPost(`/api/admin/csm-inbox/${message.id}/notify`); await loadCsmInbox(); }
      catch (error) { setStatus(csmInboxStatus, error.message || "The CSM update could not be retried."); }
      finally { retry.disabled = false; }
    });
    callback.append(retry);
    card.append(callback);
  }
  return card;
};

const updateCsmInboxBadge = (counts = {}) => {
  const open = Number(counts.pending || 0) + Number(counts.needs_match || 0) + Number(counts.failed || 0);
  csmInboxBadge.textContent = String(open);
  approveAllCsmInboxButton.disabled = open === 0;
  approveAllCsmInboxButton.textContent = open
    ? `Approve all awaiting (${open})` : "All transactions reviewed";
  return open;
};

const loadCsmInbox = async () => {
  if (!activeDataKeyBytes) return;
  setStatus(csmInboxStatus, "Loading CSM transactions...", "success");
  csmInboxList.setAttribute("aria-busy", "true");
  try {
    const result = await csmPost(CSM_INBOX_LIST_URL, { status: csmInboxFilter.value });
    renderCsmGivingSummary(result.givingSummary);
    const cards = result.messages.map(renderCsmInboxCard);
    if (!cards.length) {
      const empty = csmElement("article", "csm-inbox__card");
      empty.append(csmElement("h4", "", "No transactions in this view"), csmElement("p", "", "New CSM transactions will appear here for review."));
      cards.push(empty);
    }
    csmInboxList.replaceChildren(...cards);
    const open = updateCsmInboxBadge(result.counts);
    setStatus(csmInboxStatus, open ? `${open} transaction${open === 1 ? "" : "s"} awaiting review.` : "The CSM inbox is clear.", "success");
  } catch (error) {
    setStatus(csmInboxStatus, error.message || "The CSM inbox could not be loaded.");
  } finally {
    csmInboxList.removeAttribute("aria-busy");
  }
};

const approveAllCsmInbox = async () => {
  if (!activeDataKeyBytes || approveAllCsmInboxButton.disabled) return;
  const originalText = approveAllCsmInboxButton.textContent;
  let latestCounts = null;
  let reloaded = false;
  approveAllCsmInboxButton.disabled = true;
  approveAllCsmInboxButton.setAttribute("aria-busy", "true");
  try {
    let page = await csmPost(CSM_INBOX_LIST_URL, { status: "open" });
    latestCounts = page.counts;
    const total = Number(page.counts?.pending || 0)
      + Number(page.counts?.needs_match || 0) + Number(page.counts?.failed || 0);
    if (!total) {
      await loadCsmInbox();
      reloaded = true;
      return;
    }
    const confirmed = window.confirm(
      `Approve all ${total} awaiting JBB transactions? Received gifts will be linked to an existing donor or create a new donor record. Sent payments will not create donors.`,
    );
    if (!confirmed) return;

    const processed = new Set();
    const failures = [];
    let approved = 0;
    let createdDonors = 0;
    while (processed.size < 5000) {
      const messages = page.messages.filter(message => !processed.has(message.id));
      if (!messages.length) break;
      for (const message of messages) {
        processed.add(message.id);
        approveAllCsmInboxButton.textContent = `Approving ${Math.min(processed.size, total)} of ${total}...`;
        try {
          const result = await csmPost(
            `/api/admin/csm-inbox/${message.id}/approve`,
            csmApprovalBody(message),
          );
          approved += 1;
          if (result.createdDonor) createdDonors += 1;
        } catch (error) {
          failures.push({ name: message.displayName, error: error.message || "Approval failed" });
        }
      }
      page = await csmPost(CSM_INBOX_LIST_URL, { status: "open" });
      latestCounts = page.counts;
    }

    await loadCsmInbox();
    reloaded = true;
    const remaining = Number(csmInboxBadge.textContent || 0);
    const details = [
      `${approved} transaction${approved === 1 ? "" : "s"} approved.`,
      createdDonors ? `${createdDonors} new donor record${createdDonors === 1 ? "" : "s"} added to Donor Giving Statements.` : "",
      remaining ? `${remaining} transaction${remaining === 1 ? "" : "s"} still need attention.` : "The queue is clear.",
    ].filter(Boolean).join(" ");
    setStatus(csmInboxStatus, details, failures.length || remaining ? undefined : "success");
  } catch (error) {
    setStatus(csmInboxStatus, error.message || "The awaiting transactions could not be approved.");
  } finally {
    approveAllCsmInboxButton.removeAttribute("aria-busy");
    if (!reloaded && latestCounts) updateCsmInboxBadge(latestCounts);
    else if (!reloaded) approveAllCsmInboxButton.textContent = originalText;
    approveAllCsmInboxButton.disabled = Number(csmInboxBadge.textContent || 0) === 0;
  }
};

const initializeCsmInbox = async () => {
  if (!activeWorkbookBytes || !window.JBBPayPalSync?.extractDonorIndex) {
    await loadCsmInbox();
    return;
  }
  try {
    legacyDonorIndex = await window.JBBPayPalSync.extractDonorIndex(activeWorkbookBytes);
  } catch {
    legacyDonorIndex = [];
  }
  await loadCsmInbox();
};

const setActiveWorkbook = (bytes, file, data, revision) => {
  const previousBytes = activeWorkbookBytes;
  activeWorkbookBytes = bytes;
  activeRevision = revision;
  activePayload = {
    ...activePayload,
    file,
    encryption: { ...activePayload.encryption, data },
  };
  refreshWorkbookDownload(activeWorkbookBytes, file);
  if (previousBytes && previousBytes !== activeWorkbookBytes) {
    new Uint8Array(previousBytes).fill(0);
  }
};

csmInboxFilter.addEventListener("change", loadCsmInbox);
refreshCsmInboxButton.addEventListener("click", loadCsmInbox);
approveAllCsmInboxButton.addEventListener("click", approveAllCsmInbox);

syncPayPalButton.addEventListener("click", async () => {
  if (IS_LOCAL_PREVIEW) {
    setStatus(
      paypalSyncStatus,
      "Open joshbeyondborders.org/admin to sync PayPal donations."
    );
    return;
  }
  if (!activeDataKeyBytes || !activeWorkbookBytes || !activeRevision ||
      activePayload?.version !== 2) {
    showLogin();
    setStatus(loginStatus, "Your secure sign-in has expired. Sign in again and retry.");
    return;
  }
  syncPayPalButton.disabled = true;
  setStatus(
    paypalSyncStatus,
    "Checking PayPal for new Josh Beyond Borders donations...",
    "success"
  );
  try {
    const dataKey = bytesToBase64(activeDataKeyBytes);
    const payPal = await postAdminJson(PAYPAL_DONATIONS_URL, { dataKey });
    if (payPal.itemTitle !== window.JBBPayPalSync?.itemTitle ||
        payPal.itemId !== window.JBBPayPalSync?.itemId ||
        !Array.isArray(payPal.donations)) {
      throw new Error("PayPal returned an unexpected campaign report. Nothing was changed.");
    }
    if (!payPal.donations.length) {
      setStatus(
        paypalSyncStatus,
        "PayPal was checked successfully. No Josh Beyond Borders donations were found in the current search period.",
        "success"
      );
      return;
    }

    setStatus(
      paypalSyncStatus,
      "Checking for duplicates and preparing the encrypted workbook...",
      "success"
    );
    const merged = await window.JBBPayPalSync.mergeDonations(
      activeWorkbookBytes,
      payPal.donations,
      paypalPaidDate.value
    );
    if (!merged.added) {
      setStatus(
        paypalSyncStatus,
        `PayPal was checked successfully. All ${merged.duplicateCount} matching donation${merged.duplicateCount === 1 ? " was" : "s were"} already in the workbook.`,
        "success"
      );
      return;
    }

    const data = await encryptWorkbookData(merged.bytes, activeDataKeyBytes);
    const file = {
      name: merged.fileName,
      type: EXCEL_CONTENT_TYPE,
      size: merged.bytes.byteLength,
    };
    setStatus(
      paypalSyncStatus,
      `Publishing ${merged.added} new donation${merged.added === 1 ? "" : "s"} and the updated giving total...`,
      "success"
    );
    const published = await postAdminJson(GIVING_PUBLISH_URL, {
      dataKey,
      expectedRevision: activeRevision,
      file,
      data,
      raised: merged.grossTotal,
    });
    if (!published.revision) {
      throw new Error("The update was published, but its new version was not returned. Sign in again before syncing.");
    }
    setActiveWorkbook(merged.bytes, file, data, published.revision);
    setStatus(
      paypalSyncStatus,
      `${merged.added} new donation${merged.added === 1 ? " was" : "s were"} added and published. The gross giving total is now $${merged.grossTotal.toFixed(2)}. ${merged.duplicateCount ? `${merged.duplicateCount} duplicate${merged.duplicateCount === 1 ? " was" : "s were"} safely skipped.` : ""}`.trim(),
      "success"
    );
  } catch (error) {
    setStatus(
      paypalSyncStatus,
      error.message || "PayPal donations could not be synced. Nothing was changed."
    );
  } finally {
    syncPayPalButton.disabled = false;
  }
});

paypalPaidDate.addEventListener("change", () => {
  setStatus(paypalSyncStatus, "");
});

const attachJsonDownload = (link, payload, filename) => {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" })
  );
  updateObjectUrls.push(url);
  link.href = url;
  link.download = filename;
};

prepareUpdate.addEventListener("click", async () => {
  const file = workbookSource.files?.[0];
  if (!file || !activePassword) return;
  clearUpdateDownloads();
  prepareUpdate.disabled = true;
  setStatus(publisherStatus, "Reading the yellow total and encrypting the workbook...", "success");
  try {
    const bytes = await file.arrayBuffer();
    const total = await findYellowTotal(bytes);
    const progress = {
      version: 1,
      raised: Math.round(total.value * 100) / 100,
      goal: GIVING_GOAL,
      percent: Math.round((total.value / GIVING_GOAL) * 10000) / 100,
      updatedAt: new Date().toISOString(),
      sourceCell: total.cell,
    };
    const encrypted = await updateSecureWorkbook(bytes, file);
    attachJsonDownload(progressDownload, progress, "giving-progress.json");
    attachJsonDownload(encryptedDownload, encrypted, "giving-workbook.enc.json");
    publisherDownloads.hidden = false;
    setStatus(
      publisherStatus,
      `${total.cell} contains $${total.value.toFixed(2)}. Both secure update files are ready.`,
      "success"
    );
  } catch (error) {
    setStatus(publisherStatus, error.message || "The report could not be prepared.");
  } finally {
    prepareUpdate.disabled = false;
  }
});

[currentAdminPassword, newAdminPassword, confirmAdminPassword].forEach((field) => {
  field.addEventListener("input", () => {
    setStatus(passwordChangeStatus, "");
  });
});

passwordVisibilityButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const visible = button.getAttribute("aria-pressed") !== "true";
    setPasswordVisibility(button, visible);
  });
});

passwordChangeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const currentPassword = activePassword;
  const nextPassword = newAdminPassword.value;
  const confirmation = confirmAdminPassword.value;
  const submitButton = passwordChangeForm.querySelector("button[type='submit']");

  if (!currentPassword || !activeDataKeyBytes || activePayload?.version !== 2) {
    showLogin();
    setStatus(loginStatus, "Your secure sign-in has expired. Sign in again and retry.");
    return;
  }
  const requirementError = passwordRequirementError(nextPassword);
  if (requirementError) {
    setStatus(passwordChangeStatus, requirementError);
    newAdminPassword.focus();
    return;
  }
  if (nextPassword !== confirmation) {
    setStatus(passwordChangeStatus, "The new passwords do not match.");
    confirmAdminPassword.select();
    return;
  }
  if (nextPassword === currentPassword) {
    setStatus(passwordChangeStatus, "Choose a password that is different from the current password.");
    newAdminPassword.select();
    return;
  }
  if (IS_LOCAL_PREVIEW) {
    setStatus(
      passwordChangeStatus,
      "Password changes are saved through the live website. Open joshbeyondborders.org/admin to change it."
    );
    return;
  }

  submitButton.disabled = true;
  setStatus(passwordChangeStatus, "Protecting the workbook with the new password...", "success");
  try {
    const currentIterations = activePayload.encryption.access?.password?.iterations || 0;
    const passwordAccess = await wrapDataKey(
      activeDataKeyBytes,
      nextPassword,
      Math.max(PBKDF2_ITERATIONS, currentIterations)
    );
    const response = await fetch(PASSWORD_CHANGE_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataKey: bytesToBase64(activeDataKeyBytes),
        passwordAccess,
      }),
    });
    let result = {};
    try {
      result = await response.json();
    } catch (error) {
      // A non-JSON response means the protected update service is unavailable.
    }
    if (!response.ok) {
      throw new Error(result.error || "The password could not be updated.");
    }
    if (rememberPasswordForFuture) {
      try {
        await saveRememberedPassword(nextPassword);
      } catch (storageError) {
        rememberPasswordForFuture = false;
        await clearRememberedPassword().catch(() => {});
      }
    }
    const message = result.message || "Password updated. Sign in with the new password now.";
    showLogin();
    setStatus(loginStatus, message, "success");
  } catch (error) {
    currentAdminPassword.value = activePassword;
    setStatus(passwordChangeStatus, error.message || "The password could not be updated.");
    newAdminPassword.focus();
  } finally {
    submitButton.disabled = false;
  }
});

window.addEventListener("pagehide", () => {
  clearActiveCredentials();
  clearWorkbookDownload();
  clearUpdateDownloads();
  window.JBBDonorStatements?.clear();
});

showLogin();
