(function contactsModule(global) {
  "use strict";

  const LIST_URL = "/api/admin/contacts/list";
  const DETAIL_URL = "/api/admin/contacts/detail";
  const SAVE_URL = "/api/admin/contacts/save";
  const BULK_URL = "/api/admin/contacts/bulk-activity";
  const DELETE_URL = "/api/admin/contacts/delete";
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const date = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });
  const typeLabels = new Map();
  const state = {
    api: null,
    openGivingStatements: null,
    contacts: [],
    selected: new Set(),
    view: "cards",
    loading: false,
    requestId: 0,
    currentDetail: null,
    initialized: false,
  };

  const byId = (id) => document.getElementById(id);
  const panel = byId("contacts-panel");
  const list = byId("contacts-card-list");
  const tableWrap = byId("contacts-table-wrap");
  const tableBody = byId("contacts-table-body");
  const empty = byId("contacts-empty");
  const status = byId("contacts-status");
  const search = byId("contacts-search");
  const statusFilter = byId("contacts-status-filter");
  const typeFilter = byId("contacts-type-filter");
  const sort = byId("contacts-sort");
  const summaryShown = byId("contacts-summary-shown");
  const summaryActive = byId("contacts-summary-active");
  const summaryDonors = byId("contacts-summary-donors");
  const summaryGiving = byId("contacts-summary-giving");
  const selectionSummary = byId("contacts-selection-summary");
  const saveActivityButton = byId("contacts-save-activity");
  const createLettersButton = byId("contacts-create-letters");
  const bulkDate = byId("contacts-bulk-date");
  const bulkNote = byId("contacts-bulk-note");
  const cardViewButton = byId("contacts-view-cards");
  const tableViewButton = byId("contacts-view-table");
  const importFile = byId("contacts-import-file");
  const editorDialog = byId("contact-editor-dialog");
  const editorForm = byId("contact-editor-form");
  const editorId = byId("contact-editor-id");
  const editorTitle = byId("contact-editor-title");
  const editorTypes = byId("contact-editor-types");
  const editorStatus = byId("contact-editor-status");
  const detailDialog = byId("contact-detail-dialog");
  const detailTitle = byId("contact-detail-title");
  const detailContent = byId("contact-detail-content");
  const detailActions = byId("contact-detail-actions");
  const detailStatus = byId("contact-detail-status");

  const element = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  };

  const setStatus = (node, message, kind = "error") => {
    node.textContent = message;
    if (message) node.dataset.kind = kind;
    else node.removeAttribute("data-kind");
  };

  const isoToday = () => {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  };

  const formatDate = (value) => {
    if (!value) return "Not recorded";
    const parsed = new Date(value.length === 10 ? `${value}T12:00:00` : value);
    return Number.isNaN(parsed.valueOf()) ? value : date.format(parsed);
  };

  const formatPhone = (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    return local.length === 10 ? `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}` : String(value || "");
  };

  const formatAddress = (contact) => {
    const street = [contact.addressLine1, contact.addressLine2].filter(Boolean).join(", ");
    const locality = [contact.city, contact.region].filter(Boolean).join(", ");
    const second = [locality, contact.postalCode].filter(Boolean).join(" ");
    return [street, second, contact.country].filter(Boolean);
  };

  const contactTypeText = (contact) => (contact.contactTypes || [])
    .map((value) => typeLabels.get(value) || value.replaceAll("_", " "))
    .join(" · ") || "Contact";

  const link = (href, label) => {
    const anchor = element("a", "contacts-link", label);
    anchor.href = href;
    return anchor;
  };

  const contactCheckbox = (contact) => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.selected.has(contact.id);
    box.setAttribute("aria-label", `Select ${contact.displayName}`);
    box.addEventListener("change", () => {
      if (box.checked) state.selected.add(contact.id);
      else state.selected.delete(contact.id);
      render();
    });
    return box;
  };

  const openDetailButton = (contact, compact = false) => {
    const button = element("button", compact ? "contacts-name contacts-name--compact" : "contacts-name", contact.displayName);
    button.type = "button";
    button.addEventListener("click", () => void showDetail(contact.id));
    return button;
  };

  const appendContactMethods = (node, contact) => {
    if (contact.email) node.append(link(`mailto:${encodeURIComponent(contact.email)}`, contact.email));
    if (contact.phone) node.append(link(`tel:${contact.phone.replace(/[^\d+]/g, "")}`, formatPhone(contact.phone)));
    if (!contact.email && !contact.phone) node.append(element("span", "contacts-muted", "No email or phone"));
  };

  const cardFor = (contact) => {
    const card = element("article", "contact-card");
    if (state.selected.has(contact.id)) card.dataset.selected = "true";
    const heading = element("div", "contact-card__heading");
    heading.append(contactCheckbox(contact));
    const identity = element("div", "contact-card__identity");
    identity.append(openDetailButton(contact));
    identity.append(element("span", "contacts-type-line", contactTypeText(contact)));
    heading.append(identity);
    const badge = element("span", `contacts-status-pill contacts-status-pill--${contact.contactStatus}`, contact.contactStatus);
    heading.append(badge);

    const body = element("div", "contact-card__grid");
    const methods = element("div");
    methods.append(element("strong", "", "Contact"));
    appendContactMethods(methods, contact);
    const address = element("div");
    address.append(element("strong", "", "Mailing address"));
    const addressLines = formatAddress(contact);
    address.append(element("span", addressLines.length ? "" : "contacts-muted", addressLines.join("\n") || "Not recorded"));
    const follow = element("div");
    follow.append(element("strong", "", "Last contacted"));
    follow.append(element("span", "", formatDate(contact.lastContactedAt)));
    if (contact.lastContactedNote) follow.append(element("small", "", contact.lastContactedNote));
    const giving = element("div");
    giving.append(element("strong", "", "Giving"));
    giving.append(element("span", "contacts-giving", money.format(contact.lifetimeGiving)));
    giving.append(element("small", "", `${contact.giftCount} gift${contact.giftCount === 1 ? "" : "s"}${contact.lastGiftAt ? ` · last ${formatDate(contact.lastGiftAt)}` : ""}`));
    body.append(methods, address, follow, giving);
    if (contact.organization) card.append(element("p", "contact-card__organization", contact.organization));
    card.append(heading, body);
    return card;
  };

  const cell = (row, text = "", className = "") => {
    const item = element("td", className, text);
    row.append(item);
    return item;
  };

  const rowFor = (contact) => {
    const row = document.createElement("tr");
    if (state.selected.has(contact.id)) row.dataset.selected = "true";
    cell(row).append(contactCheckbox(contact));
    const identity = cell(row);
    identity.append(openDetailButton(contact, true));
    identity.append(element("small", "", contactTypeText(contact)));
    if (contact.organization) identity.append(element("small", "", contact.organization));
    const methods = cell(row, "", "contacts-table__contact");
    appendContactMethods(methods, contact);
    const address = cell(row);
    address.textContent = formatAddress(contact).join("\n") || "—";
    const follow = cell(row);
    follow.append(element("span", "", formatDate(contact.lastContactedAt)));
    if (contact.lastContactedNote) follow.append(element("small", "", contact.lastContactedNote));
    const giving = cell(row, "", "contacts-table__money");
    giving.append(element("strong", "", money.format(contact.lifetimeGiving)));
    giving.append(element("small", "", `${contact.giftCount} gift${contact.giftCount === 1 ? "" : "s"}`));
    const actions = cell(row);
    const view = element("button", "contacts-row-action", "View");
    view.type = "button";
    view.addEventListener("click", () => void showDetail(contact.id));
    actions.append(view);
    return row;
  };

  const updateSelection = () => {
    const count = state.selected.size;
    selectionSummary.textContent = count ? `${count} contact${count === 1 ? "" : "s"} selected.` : "No contacts selected.";
    saveActivityButton.disabled = count === 0;
    const selectedDonors = state.contacts.filter((contact) => state.selected.has(contact.id) && contact.giftCount > 0);
    createLettersButton.disabled = selectedDonors.length === 0;
  };

  const render = () => {
    if (!panel) return;
    list.replaceChildren(...state.contacts.map(cardFor));
    tableBody.replaceChildren(...state.contacts.map(rowFor));
    list.hidden = state.view !== "cards";
    tableWrap.hidden = state.view !== "table";
    empty.hidden = state.contacts.length !== 0;
    cardViewButton.setAttribute("aria-pressed", String(state.view === "cards"));
    tableViewButton.setAttribute("aria-pressed", String(state.view === "table"));
    updateSelection();
  };

  const applySummary = (summary) => {
    summaryShown.textContent = String(summary.shown || 0);
    summaryActive.textContent = String(summary.active || 0);
    summaryDonors.textContent = String(summary.donors || 0);
    summaryGiving.textContent = money.format(Number(summary.lifetimeGiving || 0));
  };

  const populateTypes = (options) => {
    const selected = typeFilter.value;
    typeLabels.clear();
    options.forEach((option) => typeLabels.set(option.value, option.label));
    const every = element("option", "", "Every contact type");
    every.value = "";
    typeFilter.replaceChildren(every, ...options.map((item) => {
      const option = element("option", "", item.label);
      option.value = item.value;
      return option;
    }));
    if ([...typeFilter.options].some((option) => option.value === selected)) typeFilter.value = selected;
    editorTypes.replaceChildren(...options.map((item) => {
      const label = element("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "contactTypes";
      input.value = item.value;
      label.append(input, document.createTextNode(item.label));
      return label;
    }));
  };

  const load = async (message = "Loading contacts…") => {
    if (!state.api) return;
    const requestId = ++state.requestId;
    state.loading = true;
    setStatus(status, message, "success");
    try {
      const result = await state.api(LIST_URL, {
        search: search.value,
        status: statusFilter.value,
        contactType: typeFilter.value,
        sort: sort.value,
      });
      if (requestId !== state.requestId) return;
      state.contacts = Array.isArray(result.contacts) ? result.contacts : [];
      const visibleIds = new Set(state.contacts.map((contact) => contact.id));
      state.selected = new Set([...state.selected].filter((id) => visibleIds.has(id)));
      populateTypes(Array.isArray(result.contactTypeOptions) ? result.contactTypeOptions : []);
      applySummary(result.summary || {});
      render();
      setStatus(status, `${state.contacts.length} contact${state.contacts.length === 1 ? "" : "s"} shown.`, "success");
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.contacts = [];
      applySummary({});
      render();
      setStatus(status, error.message || "The contact directory could not be loaded.");
    } finally {
      if (requestId === state.requestId) state.loading = false;
    }
  };

  const editorValue = (name, value = "") => {
    const field = editorForm.elements.namedItem(name);
    if (field && "value" in field) field.value = value || "";
  };

  const openEditor = (contact = null) => {
    editorForm.reset();
    editorId.value = contact?.id || "";
    editorTitle.textContent = contact ? `Edit ${contact.displayName}` : "Add a contact";
    ["displayName", "preferredName", "firstName", "lastName", "organization", "website", "email", "phone",
      "contactPreference", "contactStatus", "addressLine1", "addressLine2", "city", "region", "postalCode",
      "country", "lastContactedAt", "lastContactedNote", "notes"].forEach((name) => editorValue(name, contact?.[name] || ""));
    if (!contact) {
      editorValue("contactPreference", "email");
      editorValue("contactStatus", "active");
    }
    editorTypes.querySelectorAll("input").forEach((input) => {
      input.checked = contact ? (contact.contactTypes || []).includes(input.value) : input.value === "supporter";
    });
    setStatus(editorStatus, "");
    editorDialog.showModal();
    editorForm.elements.namedItem("displayName")?.focus();
  };

  const contactFromForm = () => {
    const data = new FormData(editorForm);
    return {
      displayName: String(data.get("displayName") || ""),
      preferredName: String(data.get("preferredName") || ""),
      firstName: String(data.get("firstName") || ""),
      lastName: String(data.get("lastName") || ""),
      organization: String(data.get("organization") || ""),
      website: String(data.get("website") || ""),
      email: String(data.get("email") || ""),
      phone: String(data.get("phone") || ""),
      contactPreference: String(data.get("contactPreference") || "email"),
      contactStatus: String(data.get("contactStatus") || "active"),
      addressLine1: String(data.get("addressLine1") || ""),
      addressLine2: String(data.get("addressLine2") || ""),
      city: String(data.get("city") || ""),
      region: String(data.get("region") || ""),
      postalCode: String(data.get("postalCode") || ""),
      country: String(data.get("country") || ""),
      lastContactedAt: String(data.get("lastContactedAt") || ""),
      lastContactedNote: String(data.get("lastContactedNote") || ""),
      notes: String(data.get("notes") || ""),
      contactTypes: data.getAll("contactTypes").map(String),
    };
  };

  const detailsLine = (label, value, href = "") => {
    const row = element("div", "contact-detail__line");
    row.append(element("dt", "", label));
    const description = element("dd");
    description.append(href ? link(href, value || "Not recorded") : document.createTextNode(value || "Not recorded"));
    row.append(description);
    return row;
  };

  const showDetail = async (contactId) => {
    setStatus(status, "Opening contact record…", "success");
    try {
      const result = await state.api(DETAIL_URL, { contactId });
      state.currentDetail = result;
      const contact = result.contact;
      detailTitle.textContent = contact.displayName;
      const profile = element("dl", "contact-detail");
      profile.append(
        detailsLine("Contact types", contactTypeText(contact)),
        detailsLine("Status", contact.contactStatus),
        detailsLine("Organization", contact.organization),
        detailsLine("Email", contact.email, contact.email ? `mailto:${encodeURIComponent(contact.email)}` : ""),
        detailsLine("Phone", formatPhone(contact.phone), contact.phone ? `tel:${contact.phone.replace(/[^\d+]/g, "")}` : ""),
        detailsLine("Preferred contact", contact.contactPreference),
        detailsLine("Mailing address", formatAddress(contact).join("\n")),
        detailsLine("Website", contact.website, contact.website),
        detailsLine("Last contacted", formatDate(contact.lastContactedAt)),
        detailsLine("Follow-up note", contact.lastContactedNote),
        detailsLine("Notes", contact.notes),
      );
      const giving = element("section", "contact-detail__giving");
      giving.append(element("h4", "", `Giving history · ${money.format(contact.lifetimeGiving)}`));
      if (result.gifts?.length) {
        const table = element("table", "contact-gift-table");
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        ["Date", "Designation", "Gross", "After fees"].forEach((label) => headRow.append(element("th", "", label)));
        head.append(headRow);
        const body = document.createElement("tbody");
        result.gifts.forEach((gift) => {
          const row = document.createElement("tr");
          [formatDate(gift.date), gift.itemTitle, money.format(gift.gross), money.format(gift.net)].forEach((value) => row.append(element("td", "", value)));
          body.append(row);
        });
        table.append(head, body);
        giving.append(table);
      } else giving.append(element("p", "contacts-muted", "No giving is linked to this contact."));
      detailContent.replaceChildren(profile, giving);
      detailActions.replaceChildren();
      const edit = element("button", "admin-submit", "Edit contact");
      edit.type = "button";
      edit.addEventListener("click", () => { detailDialog.close(); openEditor(contact); });
      detailActions.append(edit);
      if (contact.email) detailActions.append(link(`mailto:${encodeURIComponent(contact.email)}`, "Send email"));
      if (contact.phone) detailActions.append(link(`tel:${contact.phone.replace(/[^\d+]/g, "")}`, "Call"));
      if (contact.canDelete) {
        const remove = element("button", "admin-signout contact-delete", "Delete contact");
        remove.type = "button";
        remove.addEventListener("click", () => void deleteContact(contact));
        detailActions.append(remove);
      } else {
        const retained = element("span", "contact-retained", "Giving-linked records are retained; mark inactive when needed.");
        detailActions.append(retained);
      }
      setStatus(detailStatus, "");
      setStatus(status, "");
      detailDialog.showModal();
    } catch (error) {
      setStatus(status, error.message || "The contact record could not be opened.");
    }
  };

  const deleteContact = async (contact) => {
    if (!global.confirm(`Permanently delete ${contact.displayName}? This is available only because no giving or ministry transaction is linked to this record.`)) return;
    setStatus(detailStatus, "Deleting contact…", "success");
    try {
      await state.api(DELETE_URL, { contactId: contact.id });
      state.selected.delete(contact.id);
      detailDialog.close();
      await load("Refreshing contacts…");
    } catch (error) {
      setStatus(detailStatus, error.message || "The contact could not be deleted.");
    }
  };

  const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const exportCsv = () => {
    const chosen = state.selected.size
      ? state.contacts.filter((contact) => state.selected.has(contact.id))
      : state.contacts;
    if (!chosen.length) { setStatus(status, "There are no contacts to export."); return; }
    const headers = ["Display Name", "First Name", "Last Name", "Preferred Name", "Organization", "Email", "Phone", "Preferred Contact", "Status", "Contact Types", "Address Line 1", "Address Line 2", "City", "State", "Postal Code", "Country", "Last Contacted", "Last Contacted Note", "Lifetime Gross Giving", "After Fees", "Gift Count", "Notes"];
    const rows = chosen.map((contact) => [contact.displayName, contact.firstName, contact.lastName, contact.preferredName,
      contact.organization, contact.email, contact.phone, contact.contactPreference, contact.contactStatus,
      contact.contactTypes.join(", "), contact.addressLine1, contact.addressLine2, contact.city, contact.region,
      contact.postalCode, contact.country, contact.lastContactedAt, contact.lastContactedNote,
      contact.lifetimeGiving.toFixed(2), contact.netReceived.toFixed(2), contact.giftCount, contact.notes]);
    const blob = new Blob([[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `jbb-contacts-${isoToday()}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(status, `${chosen.length} contact${chosen.length === 1 ? "" : "s"} exported.`, "success");
  };

  const downloadTemplate = () => {
    const headers = ["Display Name", "First Name", "Last Name", "Preferred Name", "Organization", "Email", "Phone", "Preferred Contact", "Status", "Contact Types", "Address Line 1", "Address Line 2", "City", "State", "Postal Code", "Country", "Last Contacted", "Last Contacted Note", "Notes"];
    const sample = ["Jane Example", "Jane", "Example", "Jane", "Example Church", "jane@example.com", "(999) 999-9999", "email", "active", "supporter, prayer_partner", "123 Main St", "Suite 4", "McKinney", "TX", "75072", "US", "", "", "Replace this example row"];
    const blob = new Blob([[headers, sample].map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "jbb-contact-import-template.csv";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const parseCsv = (text) => {
    const rows = [];
    let row = [], value = "", quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"' && quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = !quoted;
      else if (character === "," && !quoted) { row.push(value); value = ""; }
      else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        row.push(value); if (row.some((cellValue) => cellValue.trim())) rows.push(row); row = []; value = "";
      } else value += character;
    }
    row.push(value); if (row.some((cellValue) => cellValue.trim())) rows.push(row);
    return rows;
  };

  const importRows = async (file) => {
    let rows;
    if (file.name.toLowerCase().endsWith(".csv")) rows = parseCsv(await file.text());
    else {
      if (!global.ExcelJS) throw new Error("The spreadsheet reader did not load. Refresh and try again.");
      const workbook = new global.ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const sheet = workbook.worksheets[0];
      rows = [];
      sheet.eachRow({ includeEmpty: false }, (sheetRow) => rows.push(sheetRow.values.slice(1).map((value) => String(value?.text ?? value ?? ""))));
    }
    if (rows.length < 2) throw new Error("The spreadsheet does not contain any contact rows.");
    if (rows.length > 251) throw new Error("Import up to 250 contacts at a time.");
    const key = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const headerMap = new Map(rows[0].map((value, index) => [key(value), index]));
    const aliases = {
      displayName: ["displayname", "name"], firstName: ["firstname"], lastName: ["lastname"], preferredName: ["preferredname"],
      organization: ["organization", "ministry", "church"], email: ["email", "emailaddress"], phone: ["phone", "cell", "cellphone"],
      contactPreference: ["preferredcontact", "contactpreference"], contactStatus: ["status", "contactstatus"], contactTypes: ["contacttypes", "contacttype"],
      addressLine1: ["addressline1", "streetaddress", "address"], addressLine2: ["addressline2", "apartmentsuite", "suite"], city: ["city"],
      region: ["state", "region"], postalCode: ["postalcode", "zipcode", "zip"], country: ["country"], lastContactedAt: ["lastcontacted", "lastcontacteddate"],
      lastContactedNote: ["lastcontactednote", "followupnote"], notes: ["notes", "note"], website: ["website"],
    };
    const column = (name) => aliases[name].map((alias) => headerMap.get(alias)).find((index) => index !== undefined);
    const get = (row, name) => { const index = column(name); return index === undefined ? "" : String(row[index] || "").trim(); };
    const emailMap = new Map(state.contacts.filter((contact) => contact.email).map((contact) => [contact.email.toLowerCase(), contact]));
    const phoneMap = new Map(state.contacts.filter((contact) => contact.phone).map((contact) => [contact.phone.replace(/\D/g, "").slice(-10), contact]));
    let saved = 0, failed = 0;
    for (const row of rows.slice(1)) {
      const email = get(row, "email");
      const phone = get(row, "phone");
      const existing = (email && emailMap.get(email.toLowerCase())) || (phone && phoneMap.get(phone.replace(/\D/g, "").slice(-10))) || null;
      const firstName = get(row, "firstName");
      const lastName = get(row, "lastName");
      const displayName = get(row, "displayName") || [firstName, lastName].filter(Boolean).join(" ");
      if (!displayName || (!email && !phone)) { failed += 1; continue; }
      const suppliedTypes = get(row, "contactTypes").split(/[,;|]/).map((item) => key(item).replace("prayerpartner", "prayer_partner").replace("ministrycontact", "ministry_contact").replace("venuecontact", "venue_contact")).filter((item) => typeLabels.has(item));
      const imported = {};
      Object.keys(aliases).filter((name) => name !== "contactTypes").forEach((name) => { const value = get(row, name); if (value) imported[name] = value; });
      const contact = {
        displayName, firstName, lastName, preferredName: "", organization: "", website: "", email, phone,
        contactPreference: email ? "email" : "phone", contactStatus: "active", addressLine1: "", addressLine2: "",
        city: "", region: "", postalCode: "", country: "", lastContactedAt: "", lastContactedNote: "", notes: "",
        contactTypes: suppliedTypes.length ? suppliedTypes : ["supporter"],
        ...(existing || {}), ...imported,
      };
      contact.displayName = displayName || contact.displayName;
      contact.email = email || contact.email;
      contact.phone = phone || contact.phone;
      contact.contactPreference = String(contact.contactPreference || "").toLowerCase() === "phone" ? "phone" : "email";
      contact.contactStatus = String(contact.contactStatus || "").toLowerCase() === "inactive" ? "inactive" : "active";
      if (suppliedTypes.length) contact.contactTypes = suppliedTypes;
      try { await state.api(SAVE_URL, { contactId: existing?.id || "", contact }); saved += 1; }
      catch { failed += 1; }
    }
    await load("Refreshing imported contacts…");
    setStatus(status, `${saved} contact${saved === 1 ? "" : "s"} imported or updated.${failed ? ` ${failed} row${failed === 1 ? "" : "s"} could not be imported.` : ""}`, failed ? "error" : "success");
  };

  const initialize = () => {
    if (state.initialized || !panel) return;
    state.initialized = true;
    let searchTimer = 0;
    search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => void load(), 300); });
    [statusFilter, typeFilter, sort].forEach((control) => control.addEventListener("change", () => void load()));
    byId("contacts-add").addEventListener("click", () => openEditor());
    byId("contacts-select-all").addEventListener("click", () => { state.contacts.forEach((contact) => state.selected.add(contact.id)); render(); });
    byId("contacts-clear-selection").addEventListener("click", () => { state.selected.clear(); render(); });
    cardViewButton.addEventListener("click", () => { state.view = "cards"; render(); });
    tableViewButton.addEventListener("click", () => { state.view = "table"; render(); });
    byId("contacts-export").addEventListener("click", exportCsv);
    byId("contacts-download-template").addEventListener("click", downloadTemplate);
    byId("contacts-import").addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const file = importFile.files?.[0];
      importFile.value = "";
      if (!file) return;
      setStatus(status, `Importing ${file.name}…`, "success");
      try { await importRows(file); } catch (error) { setStatus(status, error.message || "The contact spreadsheet could not be imported."); }
    });
    editorForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const saveButton = byId("contact-editor-save");
      saveButton.disabled = true;
      setStatus(editorStatus, "Saving contact…", "success");
      try {
        const result = await state.api(SAVE_URL, { contactId: editorId.value, contact: contactFromForm() });
        editorDialog.close();
        await load("Refreshing contacts…");
        setStatus(status, result.message || "Contact saved.", "success");
      } catch (error) { setStatus(editorStatus, error.message || "The contact could not be saved."); }
      finally { saveButton.disabled = false; }
    });
    byId("contact-editor-close").addEventListener("click", () => editorDialog.close());
    byId("contact-editor-cancel").addEventListener("click", () => editorDialog.close());
    byId("contact-detail-close").addEventListener("click", () => detailDialog.close());
    saveActivityButton.addEventListener("click", async () => {
      if (!bulkDate.value || !state.selected.size) { setStatus(status, "Select contacts and choose a Last Contacted date."); return; }
      saveActivityButton.disabled = true;
      setStatus(status, "Saving follow-up…", "success");
      try {
        const result = await state.api(BULK_URL, { contactIds: [...state.selected], lastContactedAt: bulkDate.value, lastContactedNote: bulkNote.value });
        await load("Refreshing contacts…");
        setStatus(status, `${result.updated} contact${result.updated === 1 ? "" : "s"} updated.`, "success");
      } catch (error) { setStatus(status, error.message || "The follow-up could not be saved."); }
      finally { updateSelection(); }
    });
    createLettersButton.addEventListener("click", () => {
      const donorIds = state.contacts.filter((contact) => state.selected.has(contact.id) && contact.giftCount > 0).map((contact) => contact.id);
      if (donorIds.length) state.openGivingStatements?.(donorIds);
    });
    bulkDate.value = isoToday();
  };

  const open = async ({ api, openGivingStatements }) => {
    initialize();
    state.api = api;
    state.openGivingStatements = openGivingStatements;
    state.selected.clear();
    search.value = "";
    statusFilter.value = "";
    typeFilter.value = "";
    sort.value = "name_asc";
    await load();
    search.focus();
  };

  const clear = () => {
    state.requestId += 1;
    state.api = null;
    state.openGivingStatements = null;
    state.contacts = [];
    state.selected.clear();
    state.currentDetail = null;
    state.loading = false;
    list?.replaceChildren();
    tableBody?.replaceChildren();
    if (editorDialog?.open) editorDialog.close();
    if (detailDialog?.open) detailDialog.close();
    setStatus(status, "");
  };

  global.JBBContacts = Object.freeze({ open, clear });
})(window);
