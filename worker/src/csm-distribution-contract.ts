export const CSM_DISTRIBUTION_SCHEMA_VERSION = 1 as const;

export const CSM_DESTINATIONS = ["HopeSojourns", "JoshBeyondBorders"] as const;
export type CsmDestination = (typeof CSM_DESTINATIONS)[number];
export type CsmDirection = "received" | "sent";
export type CsmPartyRole = "donor" | "payee";

export interface CsmAddressSnapshot {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  countryCode: string | null;
}

export interface CsmPartySnapshot {
  role: CsmPartyRole;
  displayName: string;
  email: string | null;
  phone: string | null;
  address: CsmAddressSnapshot | null;
}

export interface CsmTransactionSnapshot {
  sourceRecordId: string;
  paypalTransactionId: string;
  paypalReferenceId: string | null;
  eventCode: string;
  eventDate: string;
  status: string;
  direction: CsmDirection;
  currency: "USD";
  gross: number;
  fee: number;
  net: number;
  itemName: string | null;
  itemId: string | null;
}

export interface CsmDistributionMessage {
  schemaVersion: typeof CSM_DISTRIBUTION_SCHEMA_VERSION;
  messageId: string;
  idempotencyKey: string;
  sourceRevision: number;
  sentAt: string;
  destination: CsmDestination;
  product: CsmDestination;
  displayName: string;
  masterDonorId: string | null;
  party: CsmPartySnapshot;
  transaction: CsmTransactionSnapshot;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const requiredNumber = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
};

export const destinationForProduct = (product: string | null | undefined): CsmDestination | null => {
  if (product === "HopeSojourns" || product === "JoshBeyondBorders") return product;
  return null;
};

export const isPayPalPaymentEvent = (eventCode: string | null | undefined): boolean =>
  typeof eventCode === "string" && /^T00\d{2}$/.test(eventCode);

export const isEligibleDistributionSource = (source: {
  product?: string | null;
  eventCode?: string | null;
  status?: string | null;
  currency?: string | null;
  direction?: string | null;
  gross?: number | null;
}): boolean => {
  if (!destinationForProduct(source.product)) return false;
  if (!isPayPalPaymentEvent(source.eventCode)) return false;
  if ((source.status || "").toUpperCase() !== "COMPLETED") return false;
  if ((source.currency || "").toUpperCase() !== "USD") return false;
  if (source.direction === "received") return Number(source.gross) > 0;
  if (source.direction === "sent") return Number(source.gross) < 0;
  return false;
};

const parseAddress = (value: unknown): CsmAddressSnapshot | null => {
  if (value == null) return null;
  if (!isRecord(value)) throw new Error("party.address must be an object or null");
  return {
    line1: optionalString(value.line1),
    line2: optionalString(value.line2),
    city: optionalString(value.city),
    state: optionalString(value.state),
    postalCode: optionalString(value.postalCode),
    countryCode: optionalString(value.countryCode),
  };
};

export const parseDistributionMessage = (value: unknown): CsmDistributionMessage => {
  if (!isRecord(value)) throw new Error("Distribution message must be an object");
  if (value.schemaVersion !== CSM_DISTRIBUTION_SCHEMA_VERSION) {
    throw new Error("Unsupported distribution schema version");
  }

  const destination = requiredString(value.destination, "destination") as CsmDestination;
  if (!CSM_DESTINATIONS.includes(destination)) throw new Error("Unsupported destination");
  const product = requiredString(value.product, "product") as CsmDestination;
  if (product !== destination) throw new Error("product must match destination");

  if (!isRecord(value.party)) throw new Error("party is required");
  if (!isRecord(value.transaction)) throw new Error("transaction is required");
  const transaction = value.transaction;
  const direction = requiredString(transaction.direction, "transaction.direction") as CsmDirection;
  if (direction !== "received" && direction !== "sent") throw new Error("Unsupported direction");
  const role = requiredString(value.party.role, "party.role") as CsmPartyRole;
  if ((direction === "received" && role !== "donor") || (direction === "sent" && role !== "payee")) {
    throw new Error("party.role does not match direction");
  }

  const displayName = requiredString(value.displayName, "displayName");
  if (displayName !== requiredString(value.party.displayName, "party.displayName")) {
    throw new Error("displayName must match party.displayName");
  }
  const masterDonorId = optionalString(value.masterDonorId);
  if (direction === "received" && !masterDonorId) throw new Error("Received gifts require masterDonorId");
  if (direction === "sent" && masterDonorId) throw new Error("Sent payments cannot have masterDonorId");

  const parsed: CsmDistributionMessage = {
    schemaVersion: CSM_DISTRIBUTION_SCHEMA_VERSION,
    messageId: requiredString(value.messageId, "messageId"),
    idempotencyKey: requiredString(value.idempotencyKey, "idempotencyKey"),
    sourceRevision: requiredNumber(value.sourceRevision, "sourceRevision"),
    sentAt: requiredString(value.sentAt, "sentAt"),
    destination,
    product,
    displayName,
    masterDonorId,
    party: {
      role,
      displayName,
      email: optionalString(value.party.email)?.toLowerCase() || null,
      phone: optionalString(value.party.phone),
      address: parseAddress(value.party.address),
    },
    transaction: {
      sourceRecordId: requiredString(transaction.sourceRecordId, "transaction.sourceRecordId"),
      paypalTransactionId: requiredString(transaction.paypalTransactionId, "transaction.paypalTransactionId"),
      paypalReferenceId: optionalString(transaction.paypalReferenceId),
      eventCode: requiredString(transaction.eventCode, "transaction.eventCode"),
      eventDate: requiredString(transaction.eventDate, "transaction.eventDate"),
      status: requiredString(transaction.status, "transaction.status"),
      direction,
      currency: requiredString(transaction.currency, "transaction.currency").toUpperCase() as "USD",
      gross: requiredNumber(transaction.gross, "transaction.gross"),
      fee: requiredNumber(transaction.fee, "transaction.fee"),
      net: requiredNumber(transaction.net, "transaction.net"),
      itemName: optionalString(transaction.itemName),
      itemId: optionalString(transaction.itemId),
    },
  };

  if (!isEligibleDistributionSource({
    product: parsed.product,
    eventCode: parsed.transaction.eventCode,
    status: parsed.transaction.status,
    currency: parsed.transaction.currency,
    direction: parsed.transaction.direction,
    gross: parsed.transaction.gross,
  })) {
    throw new Error("Transaction is not eligible for distribution");
  }
  return parsed;
};
