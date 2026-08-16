"use strict";

const ENCRYPTED_WORKBOOK_URL = "resources/giving-workbook.enc.json";
const GIVING_GOAL = 7500;
const PBKDF2_ITERATIONS = 310000;

const loginPanel = document.querySelector("#login-panel");
const resourcesPanel = document.querySelector("#resources-panel");
const loginForm = document.querySelector("#admin-login-form");
const loginStatus = document.querySelector("#login-status");
const adminPassword = document.querySelector("#admin-password");
const signoutButton = document.querySelector("#admin-signout");
const workbookDownload = document.querySelector("#workbook-download");
const workbookSource = document.querySelector("#workbook-source");
const prepareUpdate = document.querySelector("#prepare-update");
const publisherStatus = document.querySelector("#publisher-status");
const publisherDownloads = document.querySelector("#publisher-downloads");
const progressDownload = document.querySelector("#progress-download");
const encryptedDownload = document.querySelector("#encrypted-download");

let activePassword = "";
let workbookObjectUrl = "";
let updateObjectUrls = [];

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

const loadEncryptedWorkbook = async () => {
  const response = await fetch(ENCRYPTED_WORKBOOK_URL, { cache: "no-store" });
  if (!response.ok) throw new Error("The encrypted workbook is unavailable.");
  const payload = await response.json();
  if (payload.version !== 1 || payload.encryption?.algorithm !== "AES-256-GCM") {
    throw new Error("The encrypted workbook format is not supported.");
  }
  return payload;
};

const decryptWorkbook = async (payload, password) => {
  const salt = base64ToBytes(payload.encryption.salt);
  const iv = base64ToBytes(payload.encryption.iv);
  const encryptedBytes = base64ToBytes(payload.encryption.ciphertext);
  const key = await deriveWorkbookKey(
    password,
    salt,
    payload.encryption.iterations,
    ["decrypt"]
  );
  const clearBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encryptedBytes
  );
  return { bytes: clearBytes, file: payload.file };
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

const showResources = (decrypted) => {
  clearWorkbookDownload();
  const type = decrypted.file.type ||
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  workbookObjectUrl = URL.createObjectURL(new Blob([decrypted.bytes], { type }));
  workbookDownload.href = workbookObjectUrl;
  workbookDownload.download = decrypted.file.name;
  loginPanel.hidden = true;
  resourcesPanel.hidden = false;
  signoutButton.focus();
};

const showLogin = () => {
  activePassword = "";
  clearWorkbookDownload();
  clearUpdateDownloads();
  resourcesPanel.hidden = true;
  loginPanel.hidden = false;
  loginForm.reset();
  workbookSource.value = "";
  prepareUpdate.disabled = true;
  setStatus(loginStatus, "");
  setStatus(publisherStatus, "");
  adminPassword.focus();
};

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = adminPassword.value;
  const submitButton = loginForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  setStatus(loginStatus, "Opening encrypted resources...", "success");
  try {
    const payload = await loadEncryptedWorkbook();
    const decrypted = await decryptWorkbook(payload, password);
    activePassword = password;
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

signoutButton.addEventListener("click", showLogin);

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

const encryptWorkbook = async (arrayBuffer, file, password) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWorkbookKey(password, salt, PBKDF2_ITERATIONS, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, arrayBuffer);
  return {
    version: 1,
    file: {
      name: file.name,
      type: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: file.size,
    },
    encryption: {
      algorithm: "AES-256-GCM",
      keyDerivation: "PBKDF2-SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    },
  };
};

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
    const encrypted = await encryptWorkbook(bytes, file, activePassword);
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

window.addEventListener("pagehide", () => {
  clearWorkbookDownload();
  clearUpdateDownloads();
});

showLogin();
