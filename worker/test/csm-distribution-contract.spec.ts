import { describe, expect, it } from "vitest";
import {
  isEligibleDistributionSource,
  parseDistributionMessage,
  type CsmDistributionMessage,
} from "../src/csm-distribution-contract";

const receivedMessage = (): CsmDistributionMessage => ({
  schemaVersion: 1,
  messageId: "msg-1",
  idempotencyKey: "HopeSojourns:PAYPAL-1:T0006:1",
  sourceRevision: 1,
  sentAt: "2026-08-23T12:00:00.000Z",
  destination: "HopeSojourns",
  product: "HopeSojourns",
  displayName: "Example Donor",
  masterDonorId: "csm-donor-1",
  party: {
    role: "donor",
    displayName: "Example Donor",
    email: "Donor@Example.com",
    phone: null,
    address: null,
  },
  transaction: {
    sourceRecordId: "PAYPAL-1:T0006",
    paypalTransactionId: "PAYPAL-1",
    paypalReferenceId: null,
    eventCode: "T0006",
    eventDate: "2026-08-23T11:00:00.000Z",
    status: "Completed",
    direction: "received",
    currency: "USD",
    gross: 100,
    fee: -2.48,
    net: 97.52,
    itemName: "Hope Sojourns Donation",
    itemId: "HopeSojourns",
  },
});

describe("CSM distribution contract", () => {
  it("accepts completed received and sent payment events", () => {
    expect(isEligibleDistributionSource({
      product: "HopeSojourns", eventCode: "T0006", status: "Completed", currency: "USD", direction: "received", gross: 100,
    })).toBe(true);
    expect(isEligibleDistributionSource({
      product: "JoshBeyondBorders", eventCode: "T0011", status: "Completed", currency: "USD", direction: "sent", gross: -25,
    })).toBe(true);
  });

  it("rejects PayPal holds and releases", () => {
    for (const eventCode of ["T2101", "T2102"]) {
      expect(isEligibleDistributionSource({
        product: "HopeSojourns", eventCode, status: "Completed", currency: "USD", direction: "received", gross: 100,
      })).toBe(false);
    }
  });

  it("normalizes and validates Display Name", () => {
    const parsed = parseDistributionMessage(receivedMessage());
    expect(parsed.displayName).toBe("Example Donor");
    expect(parsed.party.email).toBe("donor@example.com");

    const mismatched = receivedMessage();
    mismatched.party.displayName = "A different name";
    expect(() => parseDistributionMessage(mismatched)).toThrow("displayName must match");
  });

  it("keeps sent payments separate from donor creation", () => {
    const sent: CsmDistributionMessage = {
      ...receivedMessage(),
      destination: "JoshBeyondBorders",
      product: "JoshBeyondBorders",
      displayName: "JBB Music",
      masterDonorId: null,
      party: { ...receivedMessage().party, role: "payee", displayName: "JBB Music", email: "office@example.com" },
      transaction: {
        ...receivedMessage().transaction,
        paypalTransactionId: "PAYPAL-SENT",
        eventCode: "T0011",
        direction: "sent",
        gross: -25,
        fee: 0,
        net: -25,
      },
    };
    expect(parseDistributionMessage(sent).masterDonorId).toBeNull();
    sent.masterDonorId = "not-allowed";
    expect(() => parseDistributionMessage(sent)).toThrow("Sent payments cannot have masterDonorId");
  });
});
