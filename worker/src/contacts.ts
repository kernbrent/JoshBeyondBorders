import { fetchRepositoryWorkbook, verifyDataKey } from "./workbook-repository";
import { HttpError, isObject, jsonResponse, parseJsonRequest, requireAllowedOrigin } from "./shared";

type ContactEnv = Env & { DB: D1Database };
type ContactInput = {
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  contactPreference: "email" | "phone";
  contactStatus: "active" | "inactive";
  organization: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  lastContactedAt: string | null;
  lastContactedNote: string | null;
  notes: string | null;
  contactTypes: string[];
};

const CONTACT_TYPES = new Set([
  "donor", "supporter", "prayer_partner", "ministry_contact",
  "venue_contact", "musician", "volunteer", "other",
]);
const CONTACT_TYPE_OPTIONS = [
  { value: "donor", label: "Donor" },
  { value: "supporter", label: "Supporter" },
  { value: "prayer_partner", label: "Prayer Partner" },
  { value: "ministry_contact", label: "Ministry Contact" },
  { value: "venue_contact", label: "Venue Contact" },
  { value: "musician", label: "Musician" },
  { value: "volunteer", label: "Volunteer" },
  { value: "other", label: "Other" },
];

const cleanLine = (value: unknown, maximum: number): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length > maximum || /[\u0000-\u001F\u007F]/.test(cleaned)) {
    throw new HttpError(422, "One of the contact fields is too long or contains unsupported characters.");
  }
  return cleaned;
};

const cleanNotes = (value: unknown, maximum: number): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
  if (!cleaned) return null;
  if (cleaned.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(cleaned)) {
    throw new HttpError(422, "The contact notes are too long or contain unsupported characters.");
  }
  return cleaned;
};

const normalizedEmail = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("en-US");
const normalizedPhone = (value: string): string | null => {
  const digits = value.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length >= 7 && local.length <= 15 ? local : null;
};
const validDate = (value: unknown): string | null => {
  const cleaned = cleanLine(value, 10);
  if (!cleaned) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (!match) throw new HttpError(422, "Enter the Last Contacted date as YYYY-MM-DD.");
  const date = new Date(`${cleaned}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== cleaned) {
    throw new HttpError(422, "Enter a valid Last Contacted date.");
  }
  return cleaned;
};

const parseContactTypes = (value: unknown, hasGifts = false): string[] => {
  const requested = Array.isArray(value) ? value : [];
  const types = [...new Set(requested.filter((item): item is string =>
    typeof item === "string" && CONTACT_TYPES.has(item)
  ))];
  if (hasGifts && !types.includes("donor")) types.unshift("donor");
  return types.length ? types : [hasGifts ? "donor" : "supporter"];
};

const parseContact = (value: unknown, hasGifts = false): ContactInput => {
  if (!isObject(value)) throw new HttpError(400, "The contact could not be read.");
  const firstName = cleanLine(value.firstName, 70);
  const lastName = cleanLine(value.lastName, 70);
  const suppliedDisplayName = cleanLine(value.displayName, 160);
  const displayName = suppliedDisplayName || [firstName, lastName].filter(Boolean).join(" ");
  if (!displayName) throw new HttpError(422, "Enter the contact's name.");
  const email = cleanLine(value.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpError(422, "Enter a valid email address.");
  }
  const phone = cleanLine(value.phone, 40);
  const phoneKey = phone ? normalizedPhone(phone) : null;
  if (phone && !phoneKey) throw new HttpError(422, "Enter a valid phone number.");
  if (!email && !phone) throw new HttpError(422, "Enter at least an email address or phone number.");
  const contactPreference = value.contactPreference === "phone" ? "phone" : "email";
  if (contactPreference === "email" && !email) throw new HttpError(422, "Add an email address or choose Phone as the preferred contact method.");
  if (contactPreference === "phone" && !phone) throw new HttpError(422, "Add a phone number or choose Email as the preferred contact method.");
  const contactStatus = value.contactStatus === "inactive" ? "inactive" : "active";
  const website = cleanLine(value.website, 300);
  if (website) {
    try {
      const parsed = new URL(website);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    } catch {
      throw new HttpError(422, "Enter a complete website address beginning with http:// or https://.");
    }
  }
  return {
    displayName,
    firstName,
    lastName,
    preferredName: cleanLine(value.preferredName, 70),
    email,
    emailNormalized: email ? normalizedEmail(email) : null,
    phone,
    phoneNormalized: phoneKey,
    contactPreference,
    contactStatus,
    organization: cleanLine(value.organization, 160),
    website,
    addressLine1: cleanLine(value.addressLine1, 160),
    addressLine2: cleanLine(value.addressLine2, 160),
    city: cleanLine(value.city, 100),
    region: cleanLine(value.region, 100),
    postalCode: cleanLine(value.postalCode, 30),
    country: cleanLine(value.country, 100),
    lastContactedAt: validDate(value.lastContactedAt),
    lastContactedNote: cleanLine(value.lastContactedNote, 50),
    notes: cleanNotes(value.notes, 5_000),
    contactTypes: parseContactTypes(value.contactTypes, hasGifts),
  };
};

const requireWorkbookKey = async (env: ContactEnv, dataKey: unknown): Promise<void> => {
  if (typeof dataKey !== "string" || dataKey.length < 1 || dataKey.length > 128) {
    throw new HttpError(401, "Your secure sign-in has expired. Sign in again and retry.");
  }
  const current = await fetchRepositoryWorkbook(env);
  if (!(await verifyDataKey(dataKey, current.payload.encryption.keyVerification))) {
    throw new HttpError(401, "Your secure sign-in has expired. Sign in again and retry.");
  }
};

const readBody = async (request: Request, env: ContactEnv, maximum = 128_000): Promise<{
  origin: string; body: Record<string, unknown>;
}> => {
  const origin = requireAllowedOrigin(request, env);
  const parsed = await parseJsonRequest(request, maximum, "The contact request could not be read.");
  if (!isObject(parsed)) throw new HttpError(400, "The contact request could not be read.");
  await requireWorkbookKey(env, parsed.dataKey);
  return { origin, body: parsed };
};

const contactTypesFor = (row: Record<string, unknown>): string[] => String(row.contact_types || "")
  .split("|")
  .filter(Boolean);

const contactJson = (row: Record<string, unknown>) => ({
  id: String(row.id),
  displayName: String(row.display_name || "Unnamed contact"),
  firstName: row.first_name ? String(row.first_name) : "",
  lastName: row.last_name ? String(row.last_name) : "",
  preferredName: row.preferred_name ? String(row.preferred_name) : "",
  email: row.email ? String(row.email) : "",
  phone: row.phone ? String(row.phone) : "",
  contactPreference: String(row.contact_preference || "email"),
  contactStatus: String(row.contact_status || "active"),
  organization: row.organization ? String(row.organization) : "",
  website: row.website ? String(row.website) : "",
  addressLine1: row.address_line_1 ? String(row.address_line_1) : "",
  addressLine2: row.address_line_2 ? String(row.address_line_2) : "",
  city: row.city ? String(row.city) : "",
  region: row.region ? String(row.region) : "",
  postalCode: row.postal_code ? String(row.postal_code) : "",
  country: row.country ? String(row.country) : "",
  notes: row.notes ? String(row.notes) : "",
  lastContactedAt: row.last_contacted_at ? String(row.last_contacted_at) : "",
  lastContactedNote: row.last_contacted_note ? String(row.last_contacted_note) : "",
  source: String(row.source || "manual"),
  createdAt: String(row.created_at || ""),
  updatedAt: String(row.updated_at || ""),
  contactTypes: contactTypesFor(row),
  giftCount: Number(row.gift_count || 0),
  lifetimeGiving: Number(row.lifetime_giving || 0),
  netReceived: Number(row.net_received || 0),
  lastGiftAt: row.last_gift_at ? String(row.last_gift_at) : "",
});

const baseContactSelect = `SELECT d.*,
  COALESCE((SELECT GROUP_CONCAT(contact_type, '|') FROM donor_contact_types WHERE donor_id = d.id), '') AS contact_types,
  COALESCE(g.gift_count, 0) AS gift_count,
  COALESCE(g.lifetime_giving, 0) AS lifetime_giving,
  COALESCE(g.net_received, 0) AS net_received,
  g.last_gift_at
 FROM donors d
 LEFT JOIN (
   SELECT donor_id, COUNT(*) AS gift_count, SUM(gross) AS lifetime_giving,
          SUM(net) AS net_received, MAX(transaction_date) AS last_gift_at
   FROM financial_transactions WHERE direction = 'received' GROUP BY donor_id
 ) g ON g.donor_id = d.id`;

async function listContacts(request: Request, env: ContactEnv): Promise<Response> {
  const { origin, body } = await readBody(request, env);
  const search = cleanLine(body.search, 100) || "";
  const status = body.status === "inactive" ? "inactive" : body.status === "active" ? "active" : "";
  const contactType = typeof body.contactType === "string" && CONTACT_TYPES.has(body.contactType)
    ? body.contactType : "";
  const sort = typeof body.sort === "string" ? body.sort : "name_asc";
  const clauses: string[] = [];
  const bindings: (string | number | null)[] = [];
  if (search) {
    bindings.push(`%${search.toLocaleLowerCase("en-US")}%`);
    const bind = `?${bindings.length}`;
    clauses.push(`(lower(d.display_name) LIKE ${bind} OR lower(COALESCE(d.email, '')) LIKE ${bind}
      OR lower(COALESCE(d.phone, '')) LIKE ${bind} OR lower(COALESCE(d.organization, '')) LIKE ${bind}
      OR lower(COALESCE(d.city, '')) LIKE ${bind} OR lower(COALESCE(d.region, '')) LIKE ${bind}
      OR lower(COALESCE(d.notes, '')) LIKE ${bind})`);
  }
  if (status) {
    bindings.push(status);
    clauses.push(`d.contact_status = ?${bindings.length}`);
  }
  if (contactType) {
    bindings.push(contactType);
    clauses.push(`EXISTS (SELECT 1 FROM donor_contact_types t WHERE t.donor_id = d.id AND t.contact_type = ?${bindings.length})`);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const ordering: Record<string, string> = {
    name_asc: "d.display_name COLLATE NOCASE ASC",
    name_desc: "d.display_name COLLATE NOCASE DESC",
    recently_updated: "d.updated_at DESC, d.display_name COLLATE NOCASE ASC",
    recently_contacted: "d.last_contacted_at DESC, d.display_name COLLATE NOCASE ASC",
    giving_high: "lifetime_giving DESC, d.display_name COLLATE NOCASE ASC",
  };
  const result = await env.DB.prepare(
    `${baseContactSelect}${where} ORDER BY ${ordering[sort] || ordering.name_asc || "d.display_name COLLATE NOCASE ASC"} LIMIT 500`,
  ).bind(...bindings).all<Record<string, unknown>>();
  const contacts = result.results.map(contactJson);
  return jsonResponse({
    contacts,
    contactTypeOptions: CONTACT_TYPE_OPTIONS,
    summary: {
      shown: contacts.length,
      active: contacts.filter(contact => contact.contactStatus === "active").length,
      donors: contacts.filter(contact => contact.giftCount > 0).length,
      lifetimeGiving: contacts.reduce((sum, contact) => sum + contact.lifetimeGiving, 0),
    },
  }, 200, origin);
}

async function contactDetail(request: Request, env: ContactEnv): Promise<Response> {
  const { origin, body } = await readBody(request, env);
  const contactId = cleanLine(body.contactId, 64);
  if (!contactId) throw new HttpError(422, "Choose a contact.");
  const [row, gifts, links] = await Promise.all([
    env.DB.prepare(`${baseContactSelect} WHERE d.id = ?1 LIMIT 1`).bind(contactId).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, paypal_transaction_id, paypal_event_code, transaction_date, gross, fee, net,
              item_name, item_id, display_name
       FROM financial_transactions WHERE donor_id = ?1 AND direction = 'received'
       ORDER BY transaction_date DESC`,
    ).bind(contactId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM csm_donor_links WHERE donor_id = ?1) AS link_count,
        (SELECT COUNT(*) FROM csm_distribution_inbox WHERE matched_donor_id = ?1) AS inbox_count`,
    ).bind(contactId).first<{ link_count: number; inbox_count: number }>(),
  ]);
  if (!row) throw new HttpError(404, "This contact was not found.");
  const contact = contactJson(row);
  return jsonResponse({
    contact: {
      ...contact,
      canDelete: contact.giftCount === 0 && Number(links?.link_count || 0) === 0 && Number(links?.inbox_count || 0) === 0,
    },
    gifts: gifts.results.map(gift => ({
      id: String(gift.id),
      transactionId: String(gift.paypal_transaction_id),
      eventCode: String(gift.paypal_event_code),
      date: String(gift.transaction_date),
      gross: Number(gift.gross),
      fee: Number(gift.fee),
      net: Number(gift.net),
      itemTitle: gift.item_name ? String(gift.item_name) : "Josh Beyond Borders Donation",
    })),
  }, 200, origin);
}

async function ensureUniqueContact(env: ContactEnv, input: ContactInput, contactId = ""): Promise<void> {
  if (input.emailNormalized) {
    const duplicate = await env.DB.prepare(
      "SELECT id FROM donors WHERE email_normalized = ?1 AND id <> ?2 LIMIT 1",
    ).bind(input.emailNormalized, contactId).first<{ id: string }>();
    if (duplicate) throw new HttpError(409, "A contact with this email address already exists.");
  }
  if (input.phoneNormalized) {
    const duplicate = await env.DB.prepare(
      "SELECT id FROM donors WHERE phone_normalized = ?1 AND id <> ?2 LIMIT 1",
    ).bind(input.phoneNormalized, contactId).first<{ id: string }>();
    if (duplicate) throw new HttpError(409, "A contact with this phone number already exists.");
  }
}

const contactTypeStatements = (
  env: ContactEnv, contactId: string, contactTypes: string[], now: string,
): D1PreparedStatement[] => contactTypes.map(contactType => env.DB.prepare(
  "INSERT INTO donor_contact_types (donor_id, contact_type, created_at) VALUES (?1, ?2, ?3)",
).bind(contactId, contactType, now));

async function saveContact(request: Request, env: ContactEnv): Promise<Response> {
  const { origin, body } = await readBody(request, env);
  const contactId = cleanLine(body.contactId, 64);
  const existing = contactId ? await env.DB.prepare(
    "SELECT id, (SELECT COUNT(*) FROM financial_transactions WHERE donor_id = donors.id AND direction = 'received') AS gift_count FROM donors WHERE id = ?1",
  ).bind(contactId).first<{ id: string; gift_count: number }>() : null;
  if (contactId && !existing) throw new HttpError(404, "This contact was not found.");
  const input = parseContact(body.contact, Number(existing?.gift_count || 0) > 0);
  await ensureUniqueContact(env, input, contactId || "");
  const now = new Date().toISOString();
  if (contactId) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE donors SET display_name = ?1, first_name = ?2, last_name = ?3, preferred_name = ?4,
          email = ?5, email_normalized = ?6, phone = ?7, phone_normalized = ?8,
          contact_preference = ?9, contact_status = ?10, organization = ?11, website = ?12,
          address_line_1 = ?13, address_line_2 = ?14, city = ?15, region = ?16,
          postal_code = ?17, country = ?18, last_contacted_at = ?19, last_contacted_note = ?20,
          notes = ?21, updated_at = ?22 WHERE id = ?23`,
      ).bind(
        input.displayName, input.firstName, input.lastName, input.preferredName,
        input.email, input.emailNormalized, input.phone, input.phoneNormalized,
        input.contactPreference, input.contactStatus, input.organization, input.website,
        input.addressLine1, input.addressLine2, input.city, input.region,
        input.postalCode, input.country, input.lastContactedAt, input.lastContactedNote,
        input.notes, now, contactId,
      ),
      env.DB.prepare("DELETE FROM donor_contact_types WHERE donor_id = ?1").bind(contactId),
      ...contactTypeStatements(env, contactId, input.contactTypes, now),
      env.DB.prepare(
        `INSERT INTO audit_events (id, entity_type, entity_id, event_type, metadata_json, created_at)
         VALUES (?1, 'contact', ?2, 'updated', NULL, ?3)`,
      ).bind(crypto.randomUUID(), contactId, now),
    ]);
    return jsonResponse({ ok: true, contactId, message: "Contact saved." }, 200, origin);
  }
  const id = crypto.randomUUID();
  const identityKey = `manual:${id}`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO donors
          (id, identity_key, display_name, first_name, last_name, preferred_name,
           email, email_normalized, phone, phone_normalized, contact_preference, contact_status,
           organization, website, address_line_1, address_line_2, city, region, postal_code, country,
           last_contacted_at, last_contacted_note, notes, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
           ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, 'manual', ?24, ?24)`,
      ).bind(
        id, identityKey, input.displayName, input.firstName, input.lastName, input.preferredName,
        input.email, input.emailNormalized, input.phone, input.phoneNormalized,
        input.contactPreference, input.contactStatus, input.organization, input.website,
        input.addressLine1, input.addressLine2, input.city, input.region, input.postalCode,
        input.country, input.lastContactedAt, input.lastContactedNote, input.notes, now,
      ),
      ...contactTypeStatements(env, id, input.contactTypes, now),
      env.DB.prepare(
        `INSERT INTO audit_events (id, entity_type, entity_id, event_type, metadata_json, created_at)
         VALUES (?1, 'contact', ?2, 'created', NULL, ?3)`,
      ).bind(crypto.randomUUID(), id, now),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new HttpError(409, "A contact with this email address or phone number already exists.");
    }
    throw error;
  }
  return jsonResponse({ ok: true, contactId: id, message: "Contact created." }, 201, origin);
}

async function bulkActivity(request: Request, env: ContactEnv): Promise<Response> {
  const { origin, body } = await readBody(request, env);
  const contactIds = Array.isArray(body.contactIds)
    ? [...new Set(body.contactIds.filter((value): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)))]
    : [];
  if (!contactIds.length || contactIds.length > 100) {
    throw new HttpError(422, "Select between 1 and 100 contacts.");
  }
  const lastContactedAt = validDate(body.lastContactedAt);
  if (!lastContactedAt) throw new HttpError(422, "Choose a Last Contacted date.");
  const lastContactedNote = cleanLine(body.lastContactedNote, 50);
  const now = new Date().toISOString();
  await env.DB.batch(contactIds.flatMap(contactId => [
    env.DB.prepare(
      "UPDATE donors SET last_contacted_at = ?1, last_contacted_note = ?2, updated_at = ?3 WHERE id = ?4",
    ).bind(lastContactedAt, lastContactedNote, now, contactId),
    env.DB.prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, metadata_json, created_at)
       VALUES (?1, 'contact', ?2, 'contacted', ?3, ?4)`,
    ).bind(crypto.randomUUID(), contactId, JSON.stringify({ lastContactedAt, lastContactedNote }), now),
  ]));
  return jsonResponse({ ok: true, updated: contactIds.length }, 200, origin);
}

async function deleteContact(request: Request, env: ContactEnv): Promise<Response> {
  const { origin, body } = await readBody(request, env);
  const contactId = cleanLine(body.contactId, 64);
  if (!contactId) throw new HttpError(422, "Choose a contact.");
  const usage = await env.DB.prepare(
    `SELECT d.id,
      (SELECT COUNT(*) FROM financial_transactions WHERE donor_id = d.id) AS gift_count,
      (SELECT COUNT(*) FROM csm_donor_links WHERE donor_id = d.id) AS link_count,
      (SELECT COUNT(*) FROM csm_distribution_inbox WHERE matched_donor_id = d.id) AS inbox_count
     FROM donors d WHERE d.id = ?1`,
  ).bind(contactId).first<{ id: string; gift_count: number; link_count: number; inbox_count: number }>();
  if (!usage) throw new HttpError(404, "This contact was not found.");
  if (Number(usage.gift_count) || Number(usage.link_count) || Number(usage.inbox_count)) {
    throw new HttpError(409, "This contact is connected to giving records and cannot be deleted. Mark the contact inactive instead.");
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM donors WHERE id = ?1").bind(contactId),
    env.DB.prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, metadata_json, created_at)
       VALUES (?1, 'contact', ?2, 'deleted', NULL, ?3)`,
    ).bind(crypto.randomUUID(), contactId, now),
  ]);
  return jsonResponse({ ok: true, contactId }, 200, origin);
}

export async function handleContactsRequest(
  request: Request, env: ContactEnv, path: string,
): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "This contact action is not supported.");
  if (path === "/api/admin/contacts/list") return listContacts(request, env);
  if (path === "/api/admin/contacts/detail") return contactDetail(request, env);
  if (path === "/api/admin/contacts/save") return saveContact(request, env);
  if (path === "/api/admin/contacts/bulk-activity") return bulkActivity(request, env);
  if (path === "/api/admin/contacts/delete") return deleteContact(request, env);
  throw new HttpError(404, "Not found.");
}
