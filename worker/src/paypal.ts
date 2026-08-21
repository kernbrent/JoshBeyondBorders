import {
  HttpError,
  bytesToBase64,
  isNonemptyString,
  isObject,
} from "./shared";

const PAYPAL_API_ORIGIN = "https://api-m.paypal.com";
const MAX_PAYPAL_PAGES_PER_WINDOW = 20;
const MAX_RETURNED_DONATIONS = 500;
const MILLISECONDS_PER_DAY = 86_400_000;
const ALLOWED_PAYMENT_EVENT_CODES = new Set(["T0000", "T0006", "T0013"]);

type NormalizedName = {
  fullName: string;
  givenName: string;
  surname: string;
};

type NormalizedAddress = {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
};

type NormalizedOption = {
  name: string;
  value: string;
};

export type PayPalDonation = {
  transactionId: string;
  transactionDate: string;
  updatedDate: string;
  eventCode: string;
  type: string;
  status: "Completed";
  currency: "USD";
  gross: number;
  fee: number;
  net: number;
  payerName: NormalizedName;
  payerEmail: string;
  payerPhone: string;
  payerAddressStatus: string;
  payerAddress: NormalizedAddress;
  shippingName: NormalizedName;
  shippingAddress: NormalizedAddress;
  itemTitle: string;
  itemId: string;
  quantity: number;
  shippingAmount: number;
  insuranceAmount: number;
  salesTaxAmount: number;
  options: NormalizedOption[];
  referenceTransactionId: string;
  invoiceNumber: string;
  customNumber: string;
  endingBalance: number | null;
  subject: string;
  note: string;
  receiverEmail: string;
};

export type PayPalDonationSearch = {
  donations: PayPalDonation[];
  searchedFrom: string;
  searchedThrough: string;
  itemTitle: string;
  itemId: string;
};

const textValue = (value: unknown, maximum = 500): string =>
  typeof value === "string" ? value.trim().slice(0, maximum) : "";

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const objectValue = (value: unknown): Record<string, unknown> =>
  isObject(value) ? value : {};

const moneyValue = (value: unknown): { currency: string; amount: number } => {
  const money = objectValue(value);
  return {
    currency: textValue(money.currency_code, 10).toUpperCase(),
    amount: numberValue(money.value),
  };
};

const normalizeName = (value: unknown): NormalizedName => {
  if (typeof value === "string") {
    return { fullName: textValue(value, 300), givenName: "", surname: "" };
  }
  const name = objectValue(value);
  const givenName = textValue(name.given_name, 150);
  const surname = textValue(name.surname, 150);
  const fullName = textValue(
    name.full_name || name.alternate_full_name || `${givenName} ${surname}`,
    300
  );
  return { fullName, givenName, surname };
};

const normalizeAddress = (value: unknown): NormalizedAddress => {
  const address = objectValue(value);
  return {
    line1: textValue(address.address_line_1 || address.line1, 300),
    line2: textValue(address.address_line_2 || address.line2, 300),
    city: textValue(address.admin_area_2 || address.city, 200),
    state: textValue(address.admin_area_1 || address.state, 200),
    postalCode: textValue(address.postal_code || address.postalCode, 50),
    countryCode: textValue(address.country_code || address.countryCode, 10).toUpperCase(),
  };
};

const normalizePhone = (value: unknown): string => {
  if (typeof value === "string") return textValue(value, 80);
  const phone = objectValue(value);
  return textValue(
    phone.national_number || phone.phone_number || phone.phone || phone.value,
    80
  );
};

const transactionType = (eventCode: string): string => {
  if (eventCode === "T0006") return "Express Checkout Payment";
  if (eventCode === "T0013") return "Donation Payment";
  return "General Payment";
};

const normalizeOptions = (value: unknown): NormalizedOption[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2).map((candidate) => {
    const option = objectValue(candidate);
    return {
      name: textValue(option.option_name || option.name, 200),
      value: textValue(option.option_value || option.value, 500),
    };
  }).filter((option) => option.name || option.value);
};

const normalizeDonation = (
  candidate: unknown,
  env: Env
): PayPalDonation | null => {
  const detail = objectValue(candidate);
  const transaction = objectValue(detail.transaction_info);
  const payer = objectValue(detail.payer_info);
  const shipping = objectValue(detail.shipping_info);
  const cart = objectValue(detail.cart_info);
  const itemDetails = (Array.isArray(cart.item_details) ? cart.item_details : [])
    .map(objectValue)
    .filter((item) => textValue(item.item_code, 200) || textValue(item.item_name, 300));
  const matchingItem = itemDetails
    .find((item) =>
      textValue(item.item_code, 200) === env.PAYPAL_ITEM_ID &&
      textValue(item.item_name, 300) === env.PAYPAL_ITEM_TITLE
    );
  const containsOtherItems = itemDetails.some((item) =>
    textValue(item.item_code, 200) !== env.PAYPAL_ITEM_ID ||
    textValue(item.item_name, 300) !== env.PAYPAL_ITEM_TITLE
  );
  if (!matchingItem || containsOtherItems || transaction.transaction_status !== "S") {
    return null;
  }

  const eventCode = textValue(transaction.transaction_event_code, 20);
  if (!ALLOWED_PAYMENT_EVENT_CODES.has(eventCode)) return null;
  const gross = moneyValue(transaction.transaction_amount);
  if (gross.currency !== "USD" || gross.amount <= 0) return null;

  const transactionId = textValue(transaction.transaction_id, 128);
  const transactionDate = textValue(transaction.transaction_initiation_date, 80);
  if (!transactionId || Number.isNaN(Date.parse(transactionDate))) return null;

  const feeMoney = moneyValue(transaction.fee_amount);
  const reportedFee = feeMoney.currency && feeMoney.currency !== "USD"
    ? 0
    : feeMoney.amount;
  const fee = reportedFee > 0 ? -reportedFee : reportedFee;
  const shippingAmount = moneyValue(
    matchingItem.shipping_amount || transaction.shipping_amount
  ).amount;
  const insuranceAmount = moneyValue(
    matchingItem.insurance_amount || transaction.insurance_amount
  ).amount;
  const salesTaxAmount = moneyValue(
    matchingItem.tax_amount || transaction.sales_tax_amount
  ).amount;
  const quantity = Math.max(1, numberValue(matchingItem.quantity, 1));
  const payerName = normalizeName(payer.payer_name || payer.name);
  const shippingName = normalizeName(shipping.name || shipping.shipping_name);
  const endingBalanceMoney = moneyValue(transaction.ending_balance);

  return {
    transactionId,
    transactionDate,
    updatedDate: textValue(transaction.transaction_updated_date, 80),
    eventCode,
    type: transactionType(eventCode),
    status: "Completed",
    currency: "USD",
    gross: Math.round(gross.amount * 100) / 100,
    fee: Math.round(fee * 100) / 100,
    net: Math.round((gross.amount + fee) * 100) / 100,
    payerName,
    payerEmail: textValue(payer.email_address || payer.email, 320),
    payerPhone: normalizePhone(payer.phone_number || payer.phone),
    payerAddressStatus: textValue(payer.address_status, 50),
    payerAddress: normalizeAddress(payer.address),
    shippingName,
    shippingAddress: normalizeAddress(shipping.address),
    itemTitle: env.PAYPAL_ITEM_TITLE,
    itemId: env.PAYPAL_ITEM_ID,
    quantity,
    shippingAmount: Math.round(shippingAmount * 100) / 100,
    insuranceAmount: Math.round(insuranceAmount * 100) / 100,
    salesTaxAmount: Math.round(salesTaxAmount * 100) / 100,
    options: normalizeOptions(matchingItem.options),
    referenceTransactionId: textValue(transaction.paypal_reference_id, 128),
    invoiceNumber: textValue(
      transaction.invoice_id || matchingItem.invoice_number,
      200
    ),
    customNumber: textValue(transaction.custom_field, 500),
    endingBalance: endingBalanceMoney.currency === "USD"
      ? Math.round(endingBalanceMoney.amount * 100) / 100
      : null,
    subject: textValue(transaction.transaction_subject, 500),
    note: textValue(transaction.transaction_note, 2_000),
    receiverEmail: textValue(env.PAYPAL_RECEIVER_EMAIL, 320),
  };
};

const getPayPalAccessToken = async (env: Env): Promise<string> => {
  const authorization = bytesToBase64(
    new TextEncoder().encode(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)
  );
  const response = await fetch(`${PAYPAL_API_ORIGIN}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Accept-Language": "en_US",
      "Authorization": `Basic ${authorization}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) {
    throw new HttpError(
      503,
      response.status === 401 || response.status === 403
        ? "The PayPal connection needs attention. Please contact the site administrator."
        : "PayPal could not be reached. Please try again shortly."
    );
  }
  const result: unknown = await response.json();
  if (!isObject(result) || !isNonemptyString(result.access_token, 4_000)) {
    throw new HttpError(503, "PayPal returned an invalid sign-in response.");
  }
  return result.access_token;
};

const fetchTransactionWindow = async (
  accessToken: string,
  startDate: Date,
  endDate: Date,
  env: Env
): Promise<PayPalDonation[]> => {
  const donations: PayPalDonation[] = [];
  for (let page = 1; page <= MAX_PAYPAL_PAGES_PER_WINDOW; page += 1) {
    const url = new URL(`${PAYPAL_API_ORIGIN}/v1/reporting/transactions`);
    url.searchParams.set("start_date", startDate.toISOString());
    url.searchParams.set("end_date", endDate.toISOString());
    url.searchParams.set("fields", "all");
    url.searchParams.set("transaction_status", "S");
    url.searchParams.set("balance_affecting_records_only", "Y");
    url.searchParams.set("page_size", "500");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      throw new HttpError(
        503,
        response.status === 401 || response.status === 403
          ? "The PayPal connection needs attention. Please contact the site administrator."
          : "PayPal transactions could not be loaded. Please try again shortly."
      );
    }
    const result: unknown = await response.json();
    if (!isObject(result)) {
      throw new HttpError(503, "PayPal returned an invalid transaction report.");
    }
    const details = Array.isArray(result.transaction_details)
      ? result.transaction_details
      : [];
    for (const detail of details) {
      const donation = normalizeDonation(detail, env);
      if (donation) donations.push(donation);
      if (donations.length > MAX_RETURNED_DONATIONS) {
        throw new HttpError(
          503,
          "More Josh Beyond Borders donations were found than can be safely synced at once."
        );
      }
    }
    const totalPages = Math.max(1, Math.trunc(numberValue(result.total_pages, 1)));
    if (page >= totalPages) return donations;
  }
  throw new HttpError(503, "The PayPal report is too large to sync safely at once.");
};

export const fetchPayPalDonations = async (
  env: Env,
  now = new Date()
): Promise<PayPalDonationSearch> => {
  const lookbackDays = Math.min(
    365,
    Math.max(30, Math.trunc(numberValue(env.PAYPAL_LOOKBACK_DAYS, 93)))
  );
  const oldest = new Date(now.getTime() - lookbackDays * MILLISECONDS_PER_DAY);
  const accessToken = await getPayPalAccessToken(env);
  const found: PayPalDonation[] = [];

  let windowEnd = new Date(now);
  while (windowEnd > oldest) {
    const windowStart = new Date(Math.max(
      oldest.getTime(),
      windowEnd.getTime() - 30 * MILLISECONDS_PER_DAY
    ));
    found.push(...await fetchTransactionWindow(
      accessToken,
      windowStart,
      windowEnd,
      env
    ));
    windowEnd = new Date(windowStart.getTime() - 1);
  }

  const unique = new Map<string, PayPalDonation>();
  for (const donation of found) {
    const key = `${donation.transactionId}\u0000${donation.eventCode}`;
    if (!unique.has(key)) unique.set(key, donation);
  }
  const donations = Array.from(unique.values())
    .sort((left, right) => left.transactionDate.localeCompare(right.transactionDate));

  return {
    donations,
    searchedFrom: oldest.toISOString(),
    searchedThrough: now.toISOString(),
    itemTitle: env.PAYPAL_ITEM_TITLE,
    itemId: env.PAYPAL_ITEM_ID,
  };
};

export { normalizeDonation };
