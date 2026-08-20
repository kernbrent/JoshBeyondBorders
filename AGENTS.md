# Josh Beyond Borders project instructions

## PayPal donation imports

When the user supplies a PayPal activity CSV and asks to update giving records:

- Treat the existing encrypted Admin workbook as the authoritative donation ledger.
- Decrypt it only in a private local workspace; never commit or publish a plaintext donor workbook.
- Preserve every PayPal field for valid donation rows.
- Import only completed, positive credit transactions. Exclude account withdrawals, bank transfers, debits, refunds, reversals, and other non-donation outflows.
- Check for duplicates before inserting. Use PayPal Transaction ID as the primary key. If it is absent, compare transaction date, time, donor name, gross, fee, and net amount.
- Keep the report's `Paid Date` blank until a donation is actually paid out to Josh; the PayPal transaction date remains in the adjacent date column.
- Recalculate the yellow gross total in column I and the net total in column K.
- Update `data/giving-progress.json` from the yellow gross total and the $7,500 goal.
- Re-encrypt the updated workbook with the existing Admin credential and verify it can be decrypted before replacing `admin/resources/giving-workbook.enc.json`.
- Do not commit, push, publish, or deploy unless the user explicitly requests that action.
