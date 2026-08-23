(function initializeDonorStatements(global) {
  "use strict";

  const WORKSHEET_NAME = "BeyondBordersReport";
  const CAMPAIGN_ITEM_TITLE = "Josh Beyond Borders Donation";
  const CAMPAIGN_ITEM_ID = "BeyondBorders";
  const TEMPLATE_URL = "resources/JoshBeyondBorders-Donor-Giving-Letter-Template.docx";
  const DOCX_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const WORD_NAMESPACE =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const WORD_DRAWING_NAMESPACE =
    "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
  const PICTURE_NAMESPACE =
    "http://schemas.openxmlformats.org/drawingml/2006/picture";
  const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
  const REQUIRED_HEADERS = new Map([
    [5, "Name"],
    [7, "Status"],
    [8, "Currency"],
    [9, "Gross"],
    [12, "From Email Address"],
    [14, "Transaction ID"],
    [17, "Item Title"],
    [18, "Item ID"],
  ]);

  const panel = document.querySelector("#donor-statements-panel");
  const yearSelect = document.querySelector("#donor-statement-year");
  const letterDate = document.querySelector("#donor-letter-date");
  const searchInput = document.querySelector("#donor-search");
  const summary = document.querySelector("#donor-summary");
  const tableBody = document.querySelector("#donor-table-body");
  const emptyMessage = document.querySelector("#donor-empty");
  const selectAllButton = document.querySelector("#select-all-donors");
  const clearSelectionButton = document.querySelector("#clear-donor-selection");
  const generateButton = document.querySelector("#generate-giving-statements");
  const status = document.querySelector("#donor-statement-status");

  let donorsByYear = new Map();
  let currentDonors = [];
  let visibleDonors = [];
  let selectedDonorIds = new Set();
  let documentObjectUrl = "";
  let openRequestId = 0;
  let generationRequestId = 0;

  const text = (value) => value == null ? "" : String(value).trim();

  const asArrayBuffer = (value) => {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error("Sign in again before opening donor statements.");
  };

  const cellValue = (cell) => {
    const value = cell?.value;
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value !== "object") return value;
    if ("result" in value && value.result != null) return value.result;
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || "").join("");
    }
    if ("text" in value) return value.text;
    if ("hyperlink" in value) return value.text || value.hyperlink;
    return value;
  };

  const cellText = (worksheet, row, column) => text(
    cellValue(worksheet.getCell(row, column))
  );

  const cellAmount = (worksheet, row, column) => {
    const number = Number(cellValue(worksheet.getCell(row, column)));
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
  };

  const excelDate = (value) => {
    if (value instanceof Date && !Number.isNaN(value.valueOf())) {
      return new Date(Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate()
      ));
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
    }
    const source = text(value);
    let match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(source);
    if (match) {
      let year = Number(match[3]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      return new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2])));
    }
    match = /^(\d{4})-(\d{2})-(\d{2})/.exec(source);
    if (match) {
      return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    }
    const parsed = new Date(source);
    if (Number.isNaN(parsed.valueOf())) return null;
    return new Date(Date.UTC(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth(),
      parsed.getUTCDate()
    ));
  };

  const normalizeIdentity = (value) => text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const normalizeEmail = (value) => text(value).toLowerCase();
  const normalizePhone = (value) => text(value).replace(/\D/g, "");

  const mailingAddress = (record) => {
    const cityState = [record.city, record.state].filter(Boolean).join(", ");
    const cityStateZip = [cityState, record.postalCode].filter(Boolean).join(" ");
    const country = record.country && !/^united states(?: of america)?$/i.test(record.country)
      ? record.country
      : "";
    const explicitLines = [
      record.addressLine1,
      record.addressLine2,
      cityStateZip,
      country,
    ].filter(Boolean);
    if (explicitLines.length) return explicitLines.join(", ");
    return record.shippingAddress || "";
  };

  const stripNameFromAddress = (address, name) => {
    const source = text(address);
    const donorName = text(name);
    if (!source || !donorName) return source;
    if (source.toLowerCase().startsWith(donorName.toLowerCase())) {
      return source.slice(donorName.length).replace(/^[,\s]+/, "");
    }
    return source;
  };

  const identityCandidates = (record) => {
    const name = normalizeIdentity(record.name);
    const email = normalizeEmail(record.email);
    const phone = normalizePhone(record.phone);
    const postal = normalizeIdentity(record.postalCode);
    const line1 = normalizeIdentity(record.addressLine1);
    const candidates = [];
    if (email) candidates.push(`email:${email}`);
    if (phone.length >= 7) candidates.push(`phone:${phone}`);
    if (name && postal) candidates.push(`name-postal:${name}|${postal}`);
    if (name && line1) candidates.push(`name-address:${name}|${line1}`);
    if (!candidates.length && name) candidates.push(`name:${name}`);
    return candidates;
  };

  const stableHash = (value) => {
    let hash = 0x811c9dc5;
    for (const character of value) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };

  const mergeContact = (donor, record) => {
    for (const field of [
      "name", "email", "phone", "addressLine1", "addressLine2", "city", "state",
      "postalCode", "country", "countryCode", "shippingAddress",
    ]) {
      if (record[field]) donor[field] = record[field];
    }
  };

  const verifyWorksheet = (worksheet) => {
    if (!worksheet || worksheet.name !== WORKSHEET_NAME) {
      throw new Error("The giving workbook sheet is missing or was renamed.");
    }
    for (const [column, expected] of REQUIRED_HEADERS) {
      if (cellText(worksheet, 1, column) !== expected) {
        throw new Error(`The giving workbook column ${column} no longer matches ${expected}.`);
      }
    }
  };

  const parseWorkbook = async (workbookBytes) => {
    if (!global.ExcelJS?.Workbook || !global.JBBWorkbookCompat?.normalizeForExcelJs) {
      throw new Error("The donor statement tools did not load. Refresh the page and try again.");
    }
    const compatible = await global.JBBWorkbookCompat.normalizeForExcelJs(
      asArrayBuffer(workbookBytes)
    );
    const workbook = new global.ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(compatible);
    } finally {
      new Uint8Array(compatible).fill(0);
    }
    const worksheet = workbook.getWorksheet(WORKSHEET_NAME);
    verifyWorksheet(worksheet);

    const transactionIds = new Set();
    const identityMap = new Map();
    const groups = [];
    for (let row = 3; row <= worksheet.actualRowCount; row += 1) {
      const transactionId = cellText(worksheet, row, 14);
      if (transactionId && transactionIds.has(transactionId)) continue;

      const date = excelDate(cellValue(worksheet.getCell(row, 2)));
      const statusValue = cellText(worksheet, row, 7);
      const currency = cellText(worksheet, row, 8).toUpperCase();
      const gross = cellAmount(worksheet, row, 9);
      const fee = cellAmount(worksheet, row, 10);
      const netSource = cellValue(worksheet.getCell(row, 11));
      const netNumber = netSource == null || text(netSource) === ""
        ? Number.NaN
        : Number(netSource);
      const net = Math.round((Number.isFinite(netNumber) ? netNumber : gross + fee) * 100) / 100;
      const itemTitle = cellText(worksheet, row, 17);
      const itemId = cellText(worksheet, row, 18);
      const balanceImpact = cellText(worksheet, row, 42);
      const isCampaign = itemId === CAMPAIGN_ITEM_ID || itemTitle === CAMPAIGN_ITEM_TITLE;
      if (!date || gross <= 0 || !isCampaign) continue;
      if (statusValue && statusValue.toLowerCase() !== "completed") continue;
      if (currency && currency !== "USD") continue;
      if (balanceImpact && balanceImpact.toLowerCase() !== "credit") continue;
      if (transactionId) transactionIds.add(transactionId);

      const record = {
        name: cellText(worksheet, row, 5) || "Unnamed donor",
        type: cellText(worksheet, row, 6) || "Donation",
        email: cellText(worksheet, row, 12),
        phone: cellText(worksheet, row, 38),
        transactionId,
        date,
        gross,
        fee,
        net,
        itemTitle: itemTitle || "Josh Beyond Borders",
        addressLine1: cellText(worksheet, row, 32),
        addressLine2: cellText(worksheet, row, 33),
        city: cellText(worksheet, row, 34),
        state: cellText(worksheet, row, 35),
        postalCode: cellText(worksheet, row, 36),
        country: cellText(worksheet, row, 37),
        countryCode: cellText(worksheet, row, 41),
        shippingAddress: cellText(worksheet, row, 15),
      };
      record.shippingAddress = stripNameFromAddress(record.shippingAddress, record.name);
      const candidates = identityCandidates(record);
      let donor = candidates.map((candidate) => identityMap.get(candidate)).find(Boolean);
      if (!donor) {
        const identity = candidates[0] || `row:${row}`;
        donor = {
          id: stableHash(identity),
          identity,
          name: record.name,
          email: "",
          phone: "",
          addressLine1: "",
          addressLine2: "",
          city: "",
          state: "",
          postalCode: "",
          country: "",
          countryCode: "",
          shippingAddress: "",
          latestDate: new Date(0),
          gifts: [],
          total: 0,
        };
        groups.push(donor);
      }
      candidates.forEach((candidate) => identityMap.set(candidate, donor));
      if (record.date >= donor.latestDate) {
        mergeContact(donor, record);
        donor.latestDate = record.date;
      } else {
        for (const field of [
          "name", "email", "phone", "addressLine1", "addressLine2", "city", "state",
          "postalCode", "country", "countryCode", "shippingAddress",
        ]) {
          if (!donor[field] && record[field]) donor[field] = record[field];
        }
      }
      donor.gifts.push(record);
      donor.total = Math.round((donor.total + gross) * 100) / 100;
    }

    const result = new Map();
    for (const donor of groups) {
      donor.address = mailingAddress(donor);
      donor.gifts.sort((left, right) => left.date - right.date);
      const yearGroups = new Map();
      for (const gift of donor.gifts) {
        const year = gift.date.getUTCFullYear();
        if (!yearGroups.has(year)) yearGroups.set(year, []);
        yearGroups.get(year).push(gift);
      }
      for (const [year, gifts] of yearGroups) {
        if (!result.has(year)) result.set(year, []);
        result.get(year).push({
          ...donor,
          id: `${year}-${donor.id}`,
          gifts,
          total: Math.round(gifts.reduce((sum, gift) => sum + gift.gross, 0) * 100) / 100,
          receivedTotal: Math.round(
            gifts.reduce((sum, gift) => sum + gift.net, 0) * 100
          ) / 100,
        });
      }
    }
    for (const donors of result.values()) {
      donors.sort((left, right) => left.name.localeCompare(right.name, "en", {
        sensitivity: "base",
      }));
    }
    return result;
  };

  const money = (value) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);

  const formatPhoneNumber = (value) => {
    const original = text(value);
    const digits = original.replace(/\D/g, "");
    const localDigits = digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits;
    if (localDigits.length !== 10) return original;
    return `(${localDigits.slice(0, 3)}) ${localDigits.slice(3, 6)}-${localDigits.slice(6)}`;
  };

  const dateForInput = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

  const formatLongDate = (date) => new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);

  const formatGiftDate = (date) => new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);

  const setStatus = (message, kind = "error") => {
    status.textContent = message;
    if (message) status.dataset.kind = kind;
    else status.removeAttribute("data-kind");
  };

  const revokeDocumentUrl = () => {
    if (documentObjectUrl) URL.revokeObjectURL(documentObjectUrl);
    documentObjectUrl = "";
  };

  const donorSearchText = (donor) => normalizeIdentity([
    donor.name,
    donor.address,
    donor.email,
    donor.phone,
  ].join(" "));

  const renderSummary = () => {
    const selectedTotal = currentDonors
      .filter((donor) => selectedDonorIds.has(donor.id))
      .reduce((sum, donor) => sum + donor.total, 0);
    const selectedText = selectedDonorIds.size
      ? ` ${selectedDonorIds.size} selected (${money(selectedTotal)}).`
      : " No donors selected.";
    summary.textContent = `${visibleDonors.length} of ${currentDonors.length} donors shown.${selectedText}`;
    generateButton.disabled = selectedDonorIds.size === 0;
  };

  const addSecondary = (cell, value) => {
    if (!value) return;
    const secondary = document.createElement("span");
    secondary.className = "donor-secondary";
    secondary.textContent = value;
    cell.append(secondary);
  };

  const renderDonors = () => {
    tableBody.replaceChildren();
    const query = normalizeIdentity(searchInput.value);
    visibleDonors = currentDonors.filter((donor) =>
      !query || donorSearchText(donor).includes(query)
    );
    for (const donor of visibleDonors) {
      const row = document.createElement("tr");
      row.dataset.selected = String(selectedDonorIds.has(donor.id));

      const selectCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedDonorIds.has(donor.id);
      checkbox.setAttribute("aria-label", `Create a giving letter for ${donor.name}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedDonorIds.add(donor.id);
        else selectedDonorIds.delete(donor.id);
        row.dataset.selected = String(checkbox.checked);
        renderSummary();
      });
      selectCell.append(checkbox);

      const nameCell = document.createElement("td");
      const name = document.createElement("span");
      name.className = "donor-name";
      name.textContent = donor.name;
      nameCell.append(name);
      const giftLabel = donor.gifts.length === 1 ? "1 gift" : `${donor.gifts.length} gifts`;
      addSecondary(nameCell, giftLabel);

      const addressCell = document.createElement("td");
      addressCell.textContent = donor.address || "—";
      const emailCell = document.createElement("td");
      emailCell.textContent = donor.email || "—";
      const phoneCell = document.createElement("td");
      phoneCell.textContent = formatPhoneNumber(donor.phone) || "—";
      const totalCell = document.createElement("td");
      totalCell.className = "donor-money";
      const total = document.createElement("strong");
      total.textContent = money(donor.total);
      totalCell.append(total);
      const received = document.createElement("span");
      received.className = "donor-received-total";
      received.textContent = `(${money(donor.receivedTotal)} after fees)`;
      totalCell.append(received);

      row.append(selectCell, nameCell, addressCell, emailCell, phoneCell, totalCell);
      tableBody.append(row);
    }
    emptyMessage.hidden = visibleDonors.length > 0;
    renderSummary();
  };

  const chooseYear = (year) => {
    currentDonors = donorsByYear.get(Number(year)) || [];
    selectedDonorIds = new Set();
    searchInput.value = "";
    setStatus("");
    renderDonors();
  };

  const paragraphText = (element) => Array.from(
    element.getElementsByTagNameNS(WORD_NAMESPACE, "t")
  ).map((node) => node.textContent || "").join("");

  const replacePlaceholders = (root, replacements) => {
    const textNodes = Array.from(root.getElementsByTagNameNS(WORD_NAMESPACE, "t"));
    for (const node of textNodes) {
      let value = node.textContent || "";
      for (const [placeholder, replacement] of Object.entries(replacements)) {
        value = value.split(placeholder).join(replacement);
      }
      node.textContent = value;
      if (/^\s|\s$/.test(value)) node.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve");
    }
  };

  const removeOptionalParagraph = (root, placeholder) => {
    const paragraphs = Array.from(root.getElementsByTagNameNS(WORD_NAMESPACE, "p"));
    for (const paragraph of paragraphs) {
      if (paragraphText(paragraph).includes(placeholder)) {
        paragraph.remove();
        return;
      }
    }
  };

  const expandGiftRows = (root, gifts) => {
    const rows = Array.from(root.getElementsByTagNameNS(WORD_NAMESPACE, "tr"));
    const templateRow = rows.find((row) => paragraphText(row).includes("[[GIFT_DATE]]"));
    if (!templateRow?.parentNode) {
      throw new Error("The giving letter template is missing its contribution detail row.");
    }
    const parent = templateRow.parentNode;
    for (const gift of gifts) {
      const row = templateRow.cloneNode(true);
      replacePlaceholders(row, {
        "[[GIFT_DATE]]": formatGiftDate(gift.date),
        "[[GIFT_AMOUNT]]": money(gift.gross),
        "[[DESIGNATION]]": gift.itemTitle || "Josh Beyond Borders",
        "[[PAYMENT_METHOD]]": gift.type || "Donation",
      });
      parent.insertBefore(row, templateRow);
    }
    templateRow.remove();
  };

  const greetingName = (name) => {
    const cleaned = text(name).replace(/^(mr|mrs|ms|miss|dr|rev)\.?\s+/i, "");
    if (!cleaned) return "Friend";
    if (/\b(church|ministry|ministries|foundation|organization|company|inc\.?|llc)\b/i.test(cleaned)) {
      return cleaned;
    }
    return cleaned.split(/\s+/)[0];
  };

  const cityStateZip = (donor) => {
    const cityState = [donor.city, donor.state].filter(Boolean).join(", ");
    const locality = [cityState, donor.postalCode].filter(Boolean).join(" ");
    if (donor.country && !/^united states(?: of america)?$/i.test(donor.country)) {
      return [locality, donor.country].filter(Boolean).join(", ");
    }
    return locality;
  };

  const pageBreak = (xmlDocument) => {
    const paragraph = xmlDocument.createElementNS(WORD_NAMESPACE, "w:p");
    const run = xmlDocument.createElementNS(WORD_NAMESPACE, "w:r");
    const br = xmlDocument.createElementNS(WORD_NAMESPACE, "w:br");
    br.setAttributeNS(WORD_NAMESPACE, "w:type", "page");
    run.append(br);
    paragraph.append(run);
    return paragraph;
  };

  const renumberDrawingIds = (xmlDocument) => {
    Array.from(xmlDocument.getElementsByTagNameNS(WORD_DRAWING_NAMESPACE, "docPr"))
      .forEach((node, index) => node.setAttribute("id", String(index + 1)));
    Array.from(xmlDocument.getElementsByTagNameNS(PICTURE_NAMESPACE, "cNvPr"))
      .forEach((node, index) => node.setAttribute("id", String(index + 1)));
  };

  const createDocumentBlob = async (donors, year, chosenLetterDate, templateUrl = TEMPLATE_URL) => {
    if (!global.JBBWorkbookCompat?.unpackPackage || !global.JBBWorkbookCompat?.packPackage) {
      throw new Error("The Word document tool did not load. Refresh the page and try again.");
    }
    const response = await fetch(templateUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("The giving letter template is unavailable.");
    const entries = await global.JBBWorkbookCompat.unpackPackage(await response.arrayBuffer());
    const documentEntry = entries.find((entry) => entry.name === "word/document.xml");
    if (!documentEntry) throw new Error("The giving letter template document is missing.");

    const source = new TextDecoder().decode(documentEntry.bytes);
    const xmlDocument = new DOMParser().parseFromString(source, "application/xml");
    if (xmlDocument.querySelector("parsererror")) {
      throw new Error("The giving letter template could not be read.");
    }
    const body = xmlDocument.getElementsByTagNameNS(WORD_NAMESPACE, "body")[0];
    if (!body) throw new Error("The giving letter template body is missing.");
    const sectionProperties = Array.from(body.childNodes).find((node) =>
      node.nodeType === Node.ELEMENT_NODE && node.localName === "sectPr"
    );
    if (!sectionProperties) throw new Error("The giving letter page settings are missing.");
    const templateNodes = Array.from(body.childNodes)
      .filter((node) => node !== sectionProperties)
      .map((node) => node.cloneNode(true));
    const sectionClone = sectionProperties.cloneNode(true);
    body.replaceChildren();

    donors.forEach((donor, index) => {
      const wrapper = xmlDocument.createElementNS(WORD_NAMESPACE, "w:body");
      templateNodes.forEach((node) => wrapper.append(node.cloneNode(true)));
      if (!donor.addressLine2) {
        removeOptionalParagraph(wrapper, "[[ADDRESS_LINE_2_OPTIONAL]]");
      }
      expandGiftRows(wrapper, donor.gifts);
      const fallbackAddress = donor.addressLine1 ? "" : donor.shippingAddress;
      replacePlaceholders(wrapper, {
        "[[TAX_YEAR]]": String(year),
        "[[GREETING_NAME]]": greetingName(donor.name),
        "[[DONOR_NAME]]": donor.name,
        "[[ADDRESS_LINE_1]]": donor.addressLine1 || fallbackAddress || "",
        "[[ADDRESS_LINE_2_OPTIONAL]]": donor.addressLine2 || "",
        "[[CITY_STATE_ZIP]]": cityStateZip(donor),
        "[[LETTER_DATE]]": formatLongDate(chosenLetterDate),
        "[[RECEIPT_NUMBER]]": `JBB-${year}-${stableHash(donor.identity).toUpperCase()}`,
        "[[TOTAL_GIFT_AMOUNT]]": money(donor.total),
      });
      while (wrapper.firstChild) body.append(wrapper.firstChild);
      if (index < donors.length - 1) body.append(pageBreak(xmlDocument));
    });
    body.append(sectionClone);
    renumberDrawingIds(xmlDocument);

    const serialized = new XMLSerializer().serializeToString(xmlDocument);
    if (serialized.includes("[[")) {
      throw new Error("A field in the giving letter template could not be filled.");
    }
    documentEntry.bytes = new TextEncoder().encode(serialized);
    const packageBytes = global.JBBWorkbookCompat.packPackage(entries);
    return new Blob([packageBytes], { type: DOCX_CONTENT_TYPE });
  };

  const open = async (workbookBytes) => {
    if (!panel) return;
    const requestId = ++openRequestId;
    let workingCopy;
    try {
      workingCopy = asArrayBuffer(workbookBytes).slice(0);
    } catch (error) {
      setStatus(error.message);
      return;
    }
    setStatus("Reading the secure giving workbook...", "success");
    generateButton.disabled = true;
    try {
      const parsed = await parseWorkbook(workingCopy);
      if (requestId !== openRequestId) return;
      donorsByYear = parsed;
      const years = Array.from(donorsByYear.keys()).sort((left, right) => right - left);
      if (!years.length) {
        throw new Error("No completed Josh Beyond Borders donations were found.");
      }
      yearSelect.replaceChildren(...years.map((year) => {
        const option = document.createElement("option");
        option.value = String(year);
        option.textContent = String(year);
        return option;
      }));
      letterDate.value = dateForInput(new Date());
      chooseYear(years[0]);
      yearSelect.focus();
    } catch (error) {
      if (requestId !== openRequestId) return;
      donorsByYear = new Map();
      currentDonors = [];
      visibleDonors = [];
      tableBody.replaceChildren();
      emptyMessage.hidden = false;
      summary.textContent = "";
      setStatus(error.message || "The donor records could not be opened.");
    } finally {
      if (workingCopy instanceof ArrayBuffer) new Uint8Array(workingCopy).fill(0);
    }
  };

  const clear = () => {
    openRequestId += 1;
    generationRequestId += 1;
    donorsByYear = new Map();
    currentDonors = [];
    visibleDonors = [];
    selectedDonorIds = new Set();
    revokeDocumentUrl();
    yearSelect.replaceChildren();
    searchInput.value = "";
    letterDate.value = "";
    tableBody.replaceChildren();
    summary.textContent = "";
    emptyMessage.hidden = true;
    generateButton.disabled = true;
    setStatus("");
  };

  yearSelect?.addEventListener("change", () => chooseYear(yearSelect.value));
  searchInput?.addEventListener("input", renderDonors);
  selectAllButton?.addEventListener("click", () => {
    visibleDonors.forEach((donor) => selectedDonorIds.add(donor.id));
    renderDonors();
  });
  clearSelectionButton?.addEventListener("click", () => {
    selectedDonorIds = new Set();
    renderDonors();
  });
  generateButton?.addEventListener("click", async () => {
    const requestId = ++generationRequestId;
    const selected = currentDonors.filter((donor) => selectedDonorIds.has(donor.id));
    const chosenDate = excelDate(letterDate.value);
    if (!selected.length) {
      setStatus("Select at least one donor before creating giving letters.");
      return;
    }
    if (!chosenDate) {
      setStatus("Choose a valid letter date.");
      letterDate.focus();
      return;
    }
    generateButton.disabled = true;
    setStatus(`Creating ${selected.length} giving letter${selected.length === 1 ? "" : "s"}...`, "success");
    try {
      const year = Number(yearSelect.value);
      const blob = await createDocumentBlob(selected, year, chosenDate);
      if (requestId !== generationRequestId) return;
      revokeDocumentUrl();
      documentObjectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = documentObjectUrl;
      link.download = `Josh-Beyond-Borders-${year}-Giving-Statements.docx`;
      document.body.append(link);
      link.click();
      link.remove();
      setStatus(
        `${selected.length} giving letter${selected.length === 1 ? " was" : "s were"} created in one Word document.`,
        "success"
      );
    } catch (error) {
      if (requestId !== generationRequestId) return;
      setStatus(error.message || "The giving letters could not be created.");
    } finally {
      if (requestId === generationRequestId) {
        generateButton.disabled = selectedDonorIds.size === 0;
      }
    }
  });

  global.JBBDonorStatements = Object.freeze({
    open,
    clear,
    parseWorkbook,
    createDocumentBlob,
  });
})(window);
