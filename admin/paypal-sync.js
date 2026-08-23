(function initializePayPalWorkbookSync(global) {
  "use strict";

  const CAMPAIGN_ITEM_TITLE = "Josh Beyond Borders Donation";
  const CAMPAIGN_ITEM_ID = "BeyondBorders";
  const CAMPAIGN_SUBJECT = "A charitable gift processed by Christian Steps Ministries in support of its ministries and cooperative ministry projects.";
  const WORKSHEET_NAME = "BeyondBordersReport";
  const WORKBOOK_COLUMNS = 42;
  const PAYPAL_TIME_ZONE = "America/New_York";
  const ALLOWED_EVENT_CODES = new Set(["T0000", "T0006", "T0013"]);
  const REQUIRED_HEADERS = new Map([
    [1, "Paid Date"],
    [3, "Time"],
    [9, "Gross"],
    [11, "Net"],
    [14, "Transaction ID"],
    [17, "Item Title"],
    [18, "Item ID"],
    [42, "Balance Impact"],
  ]);

  const text = (value) => value == null ? "" : String(value).trim();
  const cellText = (value) => text(value) || null;

  const amount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
  };

  const cloneStyle = (style) => JSON.parse(JSON.stringify(style || {}));

  const valueFromCell = (cell) => {
    const value = cell.value;
    if (value && typeof value === "object" && "result" in value) return Number(value.result) || 0;
    return Number(value) || 0;
  };

  const excelDate = (year, month, day) => new Date(Date.UTC(year, month - 1, day));

  const paidDateValue = (value) => {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error("Choose a valid paid date before syncing.");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = excelDate(year, month, day);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) {
      throw new Error("Choose a valid paid date before syncing.");
    }
    return date;
  };

  const transactionDateParts = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) throw new Error("PayPal returned an invalid donation date.");
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: PAYPAL_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((part) => [part.type, part.value])
    );
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    const second = Number(parts.second);
    return {
      date: excelDate(Number(parts.year), Number(parts.month), Number(parts.day)),
      time: (hour * 3600 + minute * 60 + second) / 86400,
      timeZone: text(parts.timeZoneName),
    };
  };

  const hasAddress = (address) => Boolean(
    address && [address.line1, address.line2, address.city, address.state,
      address.postalCode, address.countryCode].some(text)
  );

  const countryName = (countryCode) => {
    const code = text(countryCode).toUpperCase();
    if (!code) return "";
    try {
      return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
    } catch (error) {
      return code;
    }
  };

  const fullAddress = (name, address) => [
    text(name),
    text(address?.line1),
    text(address?.line2),
    text(address?.city),
    text(address?.state),
    text(address?.postalCode),
    countryName(address?.countryCode),
  ].filter(Boolean).join(", ");

  const addressStatus = (value) => {
    const status = text(value).toUpperCase();
    if (status === "Y" || status === "CONFIRMED") return "Confirmed";
    if (status === "N" || status === "UNCONFIRMED") return "Unconfirmed";
    return text(value);
  };

  const verifyCampaignDonation = (donation) => {
    const valid = donation &&
      donation.itemTitle === CAMPAIGN_ITEM_TITLE &&
      donation.itemId === CAMPAIGN_ITEM_ID &&
      donation.status === "Completed" &&
      donation.currency === "USD" &&
      ALLOWED_EVENT_CODES.has(donation.eventCode) &&
      amount(donation.gross) > 0 &&
      text(donation.transactionId);
    if (!valid) {
      throw new Error("PayPal returned a transaction outside the Josh Beyond Borders campaign. Nothing was changed.");
    }
  };

  const verifyWorkbookStructure = (worksheet) => {
    if (!worksheet || worksheet.name !== WORKSHEET_NAME) {
      throw new Error("The giving workbook sheet is missing or was renamed.");
    }
    for (const [column, expected] of REQUIRED_HEADERS) {
      if (text(worksheet.getCell(1, column).value) !== expected) {
        throw new Error(`The giving workbook column ${column} no longer matches ${expected}.`);
      }
    }
    if (text(worksheet.getCell("A2").value) !== "Totals:") {
      throw new Error("The giving workbook totals row is missing.");
    }
  };

  const rowValuesForDonation = (donation, paidDate) => {
    const transaction = transactionDateParts(donation.transactionDate);
    const payerName = text(donation.payerName?.fullName);
    const shippingName = text(donation.shippingName?.fullName) || payerName;
    const address = hasAddress(donation.shippingAddress)
      ? donation.shippingAddress
      : donation.payerAddress;
    const option1 = donation.options?.[0] || {};
    const option2 = donation.options?.[1] || {};
    const gross = amount(donation.gross);
    const fee = amount(donation.fee);
    return [
      paidDate,
      transaction.date,
      transaction.time,
      transaction.timeZone,
      cellText(payerName),
      cellText(donation.type),
      "Completed",
      "USD",
      gross,
      fee,
      amount(gross + fee),
      cellText(donation.payerEmail),
      cellText(donation.receiverEmail),
      cellText(donation.transactionId),
      cellText(fullAddress(shippingName, address)),
      cellText(addressStatus(donation.payerAddressStatus)),
      CAMPAIGN_ITEM_TITLE,
      CAMPAIGN_ITEM_ID,
      amount(donation.shippingAmount),
      amount(donation.insuranceAmount),
      amount(donation.salesTaxAmount),
      cellText(option1.name),
      cellText(option1.value),
      cellText(option2.name),
      cellText(option2.value),
      cellText(donation.referenceTransactionId),
      cellText(donation.invoiceNumber),
      cellText(donation.customNumber),
      Math.max(1, Number(donation.quantity) || 1),
      null,
      donation.endingBalance == null ? null : amount(donation.endingBalance),
      cellText(address?.line1),
      cellText(address?.line2),
      cellText(address?.city),
      cellText(address?.state),
      cellText(address?.postalCode),
      cellText(countryName(address?.countryCode)),
      cellText(donation.payerPhone),
      cellText(donation.subject) || CAMPAIGN_SUBJECT,
      cellText(donation.note),
      cellText(text(address?.countryCode).toUpperCase()),
      "Credit",
    ];
  };

  const appendDonation = (worksheet, values) => {
    if (values.length !== WORKBOOK_COLUMNS) {
      throw new Error("The PayPal donation does not match the giving workbook columns.");
    }
    const previousRowNumber = worksheet.actualRowCount;
    const previousStyles = Array.from({ length: WORKBOOK_COLUMNS }, (_, index) =>
      cloneStyle(worksheet.getCell(previousRowNumber, index + 1).style)
    );
    const newRow = worksheet.addRow(values);
    const rowNumber = newRow.number;
    for (let column = 1; column <= WORKBOOK_COLUMNS; column += 1) {
      worksheet.getCell(rowNumber, column).style = previousStyles[column - 1];
    }
    worksheet.getCell(rowNumber, 1).numFmt = "m/d/yy";
    worksheet.getCell(rowNumber, 2).numFmt = "m/d/yy";
    worksheet.getCell(rowNumber, 3).numFmt = "h:mm:ss";
    worksheet.getCell(rowNumber, 9).numFmt = "0.00";
    worksheet.getCell(rowNumber, 10).numFmt = "0.00";
    worksheet.getCell(rowNumber, 11).value = {
      formula: `I${rowNumber}+J${rowNumber}`,
      result: values[10],
    };
    worksheet.getCell(rowNumber, 11).numFmt = "0.00";
    worksheet.getCell(rowNumber, 36).numFmt = "@";
    return rowNumber;
  };

  const workbookFileName = (paidDate) => {
    const month = String(paidDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(paidDate.getUTCDate()).padStart(2, "0");
    const year = String(paidDate.getUTCFullYear()).slice(-2);
    return `BeyondBordersReport-${month}${day}${year}.xlsx`;
  };

  const asArrayBuffer = (value) => {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error("The updated Excel workbook could not be created.");
  };

  const mergeDonations = async (workbookBytes, donations, paidDateText) => {
    if (!global.ExcelJS?.Workbook) {
      throw new Error("The Excel update tool did not load. Refresh the page and try again.");
    }
    if (!(workbookBytes instanceof ArrayBuffer)) {
      throw new Error("Sign in again before syncing PayPal donations.");
    }
    if (!Array.isArray(donations)) {
      throw new Error("PayPal returned an invalid donation list.");
    }
    donations.forEach(verifyCampaignDonation);

    const paidDate = paidDateValue(paidDateText);
    const now = new Date();
    const fileDate = paidDate || excelDate(
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate()
    );
    const workbook = new global.ExcelJS.Workbook();
    if (!global.JBBWorkbookCompat?.normalizeForExcelJs) {
      throw new Error("The Excel compatibility tool did not load. Refresh the page and try again.");
    }
    const compatibleBytes = await global.JBBWorkbookCompat.normalizeForExcelJs(workbookBytes);
    await workbook.xlsx.load(compatibleBytes);
    const worksheet = workbook.getWorksheet(WORKSHEET_NAME);
    verifyWorkbookStructure(worksheet);

    const existingIds = new Set();
    for (let row = 3; row <= worksheet.actualRowCount; row += 1) {
      const transactionId = text(worksheet.getCell(row, 14).value);
      if (transactionId) existingIds.add(transactionId);
    }
    const uniqueIncoming = new Map();
    for (const donation of donations) {
      const transactionId = text(donation.transactionId);
      if (!uniqueIncoming.has(transactionId)) uniqueIncoming.set(transactionId, donation);
    }

    const newDonations = Array.from(uniqueIncoming.values())
      .filter((donation) => !existingIds.has(text(donation.transactionId)))
      .sort((left, right) => text(left.transactionDate).localeCompare(text(right.transactionDate)));
    if (!newDonations.length) {
      return {
        added: 0,
        duplicateCount: donations.length,
        rejectedCount: 0,
      };
    }

    for (const donation of newDonations) {
      appendDonation(worksheet, rowValuesForDonation(donation, paidDate));
    }

    const lastRow = worksheet.actualRowCount;
    let grossTotal = 0;
    let netTotal = 0;
    for (let row = 3; row <= lastRow; row += 1) {
      grossTotal += valueFromCell(worksheet.getCell(row, 9));
      netTotal += valueFromCell(worksheet.getCell(row, 11));
    }
    grossTotal = Math.round(grossTotal * 100) / 100;
    netTotal = Math.round(netTotal * 100) / 100;
    worksheet.getCell("I2").value = {
      formula: `SUM(I3:I${lastRow})`,
      result: grossTotal,
    };
    worksheet.getCell("K2").value = {
      formula: `SUM(K3:K${lastRow})`,
      result: netTotal,
    };

    const output = asArrayBuffer(await workbook.xlsx.writeBuffer());
    return {
      added: newDonations.length,
      duplicateCount: donations.length - newDonations.length,
      rejectedCount: 0,
      bytes: output,
      fileName: workbookFileName(fileDate),
      grossTotal,
      netTotal,
      lastRow,
    };
  };

  global.JBBPayPalSync = Object.freeze({
    itemTitle: CAMPAIGN_ITEM_TITLE,
    itemId: CAMPAIGN_ITEM_ID,
    mergeDonations,
  });
})(window);
