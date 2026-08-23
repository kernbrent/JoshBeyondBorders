(function initializeWorkbookCompatibility(global) {
  "use strict";

  const OOXML_MAIN_NAMESPACE =
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const UTF8_FLAG = 0x0800;
  const STORED_METHOD = 0;
  const DEFLATE_METHOD = 8;

  const asArrayBuffer = (value) => {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error("The Excel workbook could not be read.");
  };

  const requireRange = (offset, length, totalLength) => {
    if (offset < 0 || length < 0 || offset + length > totalLength) {
      throw new Error("The Excel workbook package is damaged.");
    }
  };

  const readDirectory = (arrayBuffer) => {
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
    if (entryCount === 0xffff || offset === 0xffffffff) {
      throw new Error("This Excel workbook is too large for the Admin update tool.");
    }

    const decoder = new TextDecoder();
    const entries = [];
    for (let index = 0; index < entryCount; index += 1) {
      requireRange(offset, 46, bytes.length);
      if (view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("The Excel workbook directory is damaged.");
      }
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      requireRange(offset + 46, nameLength + extraLength + commentLength, bytes.length);
      if (flags & 0x0001) {
        throw new Error("Password-protected Excel files cannot be imported here.");
      }
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

      requireRange(localOffset, 30, bytes.length);
      if (view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error("The Excel workbook contains a damaged file entry.");
      }
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      requireRange(dataOffset, compressedSize, bytes.length);
      entries.push({
        name,
        method,
        compressedBytes: bytes.subarray(dataOffset, dataOffset + compressedSize),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  };

  const readEntry = async (entry) => {
    if (entry.method === STORED_METHOD) return entry.compressedBytes.slice();
    if (entry.method !== DEFLATE_METHOD || typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot unpack the Excel workbook.");
    }
    const stream = new Blob([entry.compressedBytes])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  const crc32 = (bytes) => {
    let checksum = 0xffffffff;
    for (const byte of bytes) {
      checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
    }
    return (checksum ^ 0xffffffff) >>> 0;
  };

  const dosTimestamp = () => {
    const date = new Date();
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) |
        Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  };

  const concatenate = (parts) => {
    const size = parts.reduce((total, part) => total + part.byteLength, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  };

  const storedZip = (entries) => {
    const encoder = new TextEncoder();
    const timestamp = dosTimestamp();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = entry.bytes;
      const checksum = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, UTF8_FLAG, true);
      localView.setUint16(8, STORED_METHOD, true);
      localView.setUint16(10, timestamp.time, true);
      localView.setUint16(12, timestamp.date, true);
      localView.setUint32(14, checksum, true);
      localView.setUint32(18, data.byteLength, true);
      localView.setUint32(22, data.byteLength, true);
      localView.setUint16(26, name.length, true);
      local.set(name, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, UTF8_FLAG, true);
      centralView.setUint16(10, STORED_METHOD, true);
      centralView.setUint16(12, timestamp.time, true);
      centralView.setUint16(14, timestamp.date, true);
      centralView.setUint32(16, checksum, true);
      centralView.setUint32(20, data.byteLength, true);
      centralView.setUint32(24, data.byteLength, true);
      centralView.setUint16(28, name.length, true);
      centralView.setUint32(42, localOffset, true);
      central.set(name, 46);
      centralParts.push(central);
      localOffset += local.byteLength + data.byteLength;
    }

    const centralDirectory = concatenate(centralParts);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralDirectory.byteLength, true);
    endView.setUint32(16, localOffset, true);
    return concatenate([...localParts, centralDirectory, end]);
  };

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const normalizeWorkbookXml = (source) => {
    const namespace = escapeRegExp(OOXML_MAIN_NAMESPACE);
    const match = source.match(
      new RegExp(`xmlns:([A-Za-z_][\\w.-]*)=["']${namespace}["']`)
    );
    if (!match) return source;
    const prefix = match[1];
    const defaultNamespace = `xmlns="${OOXML_MAIN_NAMESPACE}"`;
    let normalized = source.replace(
      match[0],
      source.includes(defaultNamespace) ? "" : defaultNamespace
    );
    normalized = normalized.replace(
      new RegExp(`(<\\/?)(?:${escapeRegExp(prefix)}):`, "g"),
      "$1"
    );
    return normalized;
  };

  const normalizeWorksheetRelationships = (source) => source
    .replace(
      /Target=(["'])\/xl\/([^"']+)\1/gi,
      (match, quote, target) => `Target=${quote}../${target}${quote}`
    )
    .replace(
      /Target=(["'])\.\.\/drawings\/vmldrawing\.vml\1/gi,
      (match, quote) => `Target=${quote}../drawings/vmlDrawing1.vml${quote}`
    );

  const normalizeForExcelJs = async (value) => {
    const original = asArrayBuffer(value);
    const entries = readDirectory(original);
    if (!entries.some((entry) => entry.name === "xl/workbook.xml")) {
      throw new Error("The Excel workbook sheet list is missing.");
    }

    const decoder = new TextDecoder();
    const unpacked = [];
    let changed = false;
    for (const entry of entries) {
      let bytes = await readEntry(entry);
      let name = entry.name;
      if (/\.xml$/i.test(entry.name)) {
        const source = decoder.decode(bytes);
        const normalizedSource = normalizeWorkbookXml(source);
        if (normalizedSource !== source) {
          bytes = new TextEncoder().encode(normalizedSource);
          changed = true;
        }
      }
      if (/^xl\/worksheets\/_rels\/[^/]+\.rels$/i.test(entry.name)) {
        const source = decoder.decode(bytes);
        const normalizedSource = normalizeWorksheetRelationships(source);
        if (normalizedSource !== source) {
          bytes = new TextEncoder().encode(normalizedSource);
          changed = true;
        }
      }
      if (/^xl\/drawings\/vmldrawing\.vml$/i.test(entry.name)) {
        name = "xl/drawings/vmlDrawing1.vml";
        changed = true;
      }
      unpacked.push({
        name,
        bytes,
      });
    }
    if (!changed) return original.slice(0);
    return asArrayBuffer(storedZip(unpacked));
  };

  const unpackPackage = async (value) => {
    const original = asArrayBuffer(value);
    const entries = readDirectory(original);
    const unpacked = [];
    for (const entry of entries) {
      unpacked.push({
        name: entry.name,
        bytes: await readEntry(entry),
      });
    }
    return unpacked;
  };

  const packPackage = (entries) => {
    if (!Array.isArray(entries) || entries.some((entry) =>
      !entry || typeof entry.name !== "string" || !(entry.bytes instanceof Uint8Array)
    )) {
      throw new Error("The document package could not be created.");
    }
    return asArrayBuffer(storedZip(entries));
  };

  global.JBBWorkbookCompat = Object.freeze({
    normalizeForExcelJs,
    unpackPackage,
    packPackage,
  });
})(typeof window === "undefined" ? globalThis : window);
