# GST compliance review: invoices and credit notes (D-48, D-61)

This is an engineering checklist that maps each GST requirement to the code and test that
enforce it. It is **not legal advice**. Rows marked **CA** need sign-off from FarmX's chartered
accountant before production.

## Tax invoice: CGST Rule 46

| Requirement                                                    | Where                                                                                                                                       | Test                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Supplier name, address, GSTIN                                  | `SELLER_LEGAL_NAME` / `SELLER_ADDRESS` / `SELLER_GSTIN` (required in prod; GSTIN checksum + state = `SELLER_STATE_CODE`, `invoices.gst.ts`) | `invoices.gst.test.ts`, `invoices.pdf.test.ts`                      |
| Consecutive serial, ≤ 16 characters, unique per financial year | `FX/2627/0000123`, gapless (`invoice_sequences` row-locked in the issuing tx; a rollback returns the number)                                | `invoices.db.test.ts` (100 parallel takers, rollback leaves no gap) |
| Date of issue                                                  | `issuedAt`, printed in IST                                                                                                                  | `invoices.pdf.test.ts`                                              |
| Recipient name, address; GSTIN if registered                   | snapshot `buyer` (billing name, GSTIN checksum-validated, bill-to / ship-to from the checkout address snapshot)                             | `invoices.pdf.test.ts`                                              |
| Place of supply with state name and code (inter-state)         | `placeOfSupply` + state name; INTRA → CGST + SGST, INTER → IGST only                                                                        | `invoices.db.test.ts` (inter-state → IGST only)                     |
| HSN / SAC per line                                             | 4 / 6 / 8 digits validated; freight SAC                                                                                                     | `invoices.gst.test.ts`                                              |
| Description, quantity, unit price                              | snapshot lines                                                                                                                              | `invoices.pdf.test.ts`                                              |
| Total and taxable value after discount                         | `grossPaise − discountPaise = taxablePaise` per line                                                                                        | `invoices.gst.test.ts`                                              |
| Rate and amount of each tax head                               | CGST / SGST / IGST per line + HSN summary                                                                                                   | `invoices.pdf.test.ts`                                              |
| Whether tax is payable on reverse charge                       | "Reverse charge: No" + legal note                                                                                                           | `invoices.pdf.test.ts`                                              |
| Signature or digital signature                                 | Prints "computer-generated document" and "For <seller>". **CA:** confirm, or add a DSC.                                                     | —                                                                   |
| Amount in words (Indian system)                                | `invoices.words.ts`                                                                                                                         | `invoices.gst.test.ts`                                              |
| Exempt / nil-rated supplies → bill of supply                   | every line 0 % → `BILL_OF_SUPPLY` + wording                                                                                                 | `invoices.pdf.test.ts`                                              |

## Timing: CGST s.31

- The invoice is issued **before or at the removal of goods**. The warehouse gate-out issues the
  invoice first and dispatches only if that succeeds. It then re-checks under the shipment lock
  that the goods leaving are exactly the goods invoiced (`linesHash`).
- If issuing fails, nothing leaves. Code: warehouse `fulfilmentFloor.prepareInvoices` /
  `dispatchInTx`. Tests: warehouse `dispatch.db.test.ts` (blocked / unavailable / stale / missing).
- `DISPATCH_REQUIRE_INVOICE` can only be turned off outside prod (Joi forces it on in prod).

## Credit notes: CGST s.34, Rule 53

| Requirement                                           | Where                                                                                                                                                         | Test                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Issued when supply is short / not made / goods return | Shortage: `cn:shortage:<shipment>`. Never left (amended or cancelled before gate-out): void `cn:void:<invoice>`. Returns will reuse `creditForShipment`.      | `invoices.d61.db.test.ts`                          |
| References the original invoice number and date       | snapshot `original {docNo, issuedAt}`, printed "Against invoice"; `originalDocId`                                                                             | `invoices.pdf.test.ts`, `invoices.d61.db.test.ts`  |
| Own consecutive series                                | `CREDIT_NOTE_SERIES` (e.g. `CN/2627/…`)                                                                                                                       | `invoices.d61.db.test.ts`                          |
| Never more than the invoice; exact amounts            | cumulative builder, integer paise                                                                                                                             | `invoices.credit.test.ts` (500-case property test) |
| Time limit: 30 Nov after the end of the invoice's FY  | `creditNoteDeadline(fy)`. After that no note is issued; the refund still proceeds and an ALERT is logged. **CA:** confirm handling (commercial credit note?). | `invoices.credit.test.ts`                          |
| GSTR-1 reporting section                              | CDNR (registered) · CDNUR (original B2CL) · B2CS (net adjustment of table 7)                                                                                  | `invoices.credit.test.ts`                          |

**CA question:** an invoice voided before the goods left is reversed with a **credit note**. The
alternative is to cancel the invoice and report it in GSTR-1 table 13 ("documents issued",
cancelled), which is possible only if it is not yet reported. Credit notes are valid in every
case, so they were chosen. Confirm this is acceptable.

## Records and integrity: CGST s.35–36

- Documents are immutable at the database level:
  - no DELETE or TRUNCATE;
  - only PDF, IRN and credit-status columns may change;
  - status only moves forward;
  - a stored PDF is final.
- Each snapshot is SHA-256 hashed at issue and re-verified before every render, download and
  print. Stored PDFs carry their own SHA-256.
- Retention: keep documents for 72 months after the annual-return due date. Storage is a private
  bucket with no automatic deletion. **Ops:** set the bucket lifecycle accordingly.

## Not built (flagged)

| Item                                                   | Status                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| e-invoice (IRN, signed QR)                             | Mandatory above ₹5 crore aggregate turnover. Fields exist (`irn`, `ackNo`, `signedQr`); IRP integration is not built. **CA:** confirm turnover.                                                |
| e-way bill                                             | Consignments above ₹50,000 (`EWAY_BILL_THRESHOLD_PAISE`) are flagged `ewayBillRequired` at gate-out (warning only). Generation (NIC API) is not built. **Ops:** generate manually until it is. |
| UQC (unit of quantity) on lines and in the HSN summary | Not captured on order lines. Needed for GSTR-1 HSN-wise summary. **CA** + product data.                                                                                                        |
| Manual credit / debit notes (price corrections)        | Not built (`invoices.manage` planned).                                                                                                                                                         |
| GSTR-1 JSON export                                     | The CSV register is GSTR-1 shaped; JSON for the GST portal is not built.                                                                                                                       |
