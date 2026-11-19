# FarmX — Project Context

**Sources** (`../Documents`), in priority order:

1. Consolidated Requirements v3.0 (FXL/REQ/GEN/2026-03, the baseline; supersedes PRD Vol. I)
2. Logistics PRD/SRS (FXL/PRD/LOG/2026-03)
3. Admin-panel docs: screens, sidebar, role-wise permissions, backend modules
4. Customer-app screen PNGs

The design books (Parts 2–4) are image-only PDFs and have **not** been reviewed yet (see Open
questions). Priority key: **M** = launch (R1) · **S** = R1.1 (+60 days) · **C** = R2 (+6 months).

## 1. Features by module

**Identity and onboarding**

- **Identity:** username or mobile + password; SMS OTP on first login, password reset and device
  change; biometric unlock; mandatory MFA for internal and vendor users.
- **Delegate logins:** supervisor accounts with an order-value ceiling.
- **Sessions:** idle expiry by persona; every auth event is logged.
- **Registration:**
  - paths: Farm (Layer, Broiler, Broiler Breeder, Layer Breeder), Hatchery, Feed Mill and B2C;
  - B2C needs only mobile + address;
  - business paths capture Aadhaar (consent, masked only), PAN and GSTIN (verified on the GST
    portal);
  - field-sales-assisted registration; duplicates go to review.
- **Farm ID:** immutable and human-readable, encoding entity type and territory. One owner can
  have many farm units.
- **Farm profile:** sheds, flock by age, vaccination and disease history, geotagged photos.
  Versioned and offline-capable.
- **Vendor onboarding:**
  - public application with CIN, GST, PAN, TAN and drug-licence documents;
  - MCA, GST and CDSCO checks;
  - licence expiry warnings at 90/60/30 days, with listings and ads auto-suspended on expiry;
  - e-signed agreements; vendor scorecard.

**Catalogue, pricing and loyalty**

- **Catalogue:**
  - **only FarmX creates items**; the vendor verifies them, and corrections are itemised and
    approved;
  - lifecycle: draft → pending verification → active → suspended → discontinued;
  - pack-size variants; Rx/OTC and cold-chain flags; withdrawal periods; TDS/SDS documents;
  - Telugu search; bulk load from spreadsheet.
- **Pricing:**
  - per-item volume tier table, effective-dated and versioned;
  - B2C prices kept separately; feed-mill rate per tonne;
  - territory pricing (S);
  - overrides are Super Admin only.
- **Loyalty:** tiers on rolling 12-month spend, points ledger, coupons, combos, clearance events,
  referral (C).

**Shopping and payments**

- **Shopping:**
  - product page shows the resolved price, tier table, stock, delivery window and Rx/cold flags;
  - cart persists across devices and is revalidated at checkout;
  - Book a Sales Call button under Add to Cart.
- **Checkout and payment:**
  - Razorpay: UPI, cards, net banking, wallets, links, QR;
  - high-value B2B orders use NEFT/RTGS, auto-reconciled;
  - part or advance payment against a proforma invoice;
  - refunds to source; customer wallet (S);
  - GST invoice on dispatch, with e-invoice IRN.
- **Orders:**
  - state machine with auto-allocation to a node by pin code and FEFO batch allocation;
  - split shipments; reservation with timeout;
  - modify or cancel until picking;
  - returns with evidence; tele-caller confirmation; recurring orders; quotations (S);
  - ad and lead attribution.

**Clinical and traceability**

- **Vet consultation:**
  - voice, video and chat, booked against availability;
  - a workspace with the full farm context; structured notes;
  - field visits; lab samples with accession numbers;
  - council registration is tracked, and lapsed vets are blocked.
- **Prescriptions:**
  - per Farm ID; quantity computed from flock size;
  - states and validity; one tap adds everything to the cart;
  - auto-repeat with a count or end date; withdrawal tracker;
  - signed PDF; same-molecule substitution is flagged.
- **COA and traceability:**
  - consignment number and unit QR; COA lookup by number or QR;
  - manufacturer COA and Interferon Labs COA shown separately;
  - a failed COA quarantines the consignment and pauses its ads;
  - public verification (S);
  - a QR scan posts a goods receipt to the farm management software, with offline sync.

**Supply chain**

- **Procurement:** quotations and POs with approval bands; e-way bill before gate entry; 3-way
  match; purchase returns with debit note.
- **Warehouse (WMS):**
  - gate entry with weighbridge; challan QR scan; unit QR generation;
  - scan-based put-away to bin level; damage photos;
  - FEFO pick (wrong scans rejected); cold-chain pack; scan-out;
  - inter-node transfers; quarantine; daily expiry monitoring;
  - **no stock edits by warehouse staff.**
- **Logistics:**
  - partner self-registration with Aadhaar and documents (expiry auto-suspends);
  - job board with fare = km × rate;
  - pickup custody; tracking; OTP + photo POD;
  - partial delivery, refusal and failure handling; live tracking link;
  - offline-first driver app; trip ledger.
- **Cold chain and QMS:** loggers and IoT readings; excursions and alerts; quality holds;
  deviations and CAPA; calibration; recall with forward/backward trace.

**Money**

- **Settlement:**
  - the vendor payable per unit joins the same-day payout run once fulfilment is confirmed;
  - RazorpayX batches with retry; vendor ledger with TDS/TCS;
  - reversals need Super Admin approval;
  - fares and vet fees are paid through the same system;
  - exposure report.
- **Finance:** GST by HSN and place of supply; e-invoicing; e-way bills; TDS/TCS; credit/debit
  notes; gateway reconciliation; **customer credit is blocked**.

**Growth**

- **Ads (vendor):**
  - Book Ad Slot with targeting by territory, age band and production type, and a minimum
    audience;
  - live fares with a 15-minute hold; paid by Razorpay or ad wallet;
  - Ad Ops authorizes and a content reviewer validates (different users);
  - always labelled "Sponsored"; impression rules;
  - pause on stock-out or recall; make-goods.
- **Liquidation:** vendor-run near-expiry, flash, combo, territory and year-end clearance, within
  guardrails. Category Manager approves anything outside them. Fees are netted from payouts.
- **Leads:**
  - Book a Sales Call → scored lead (SQL/MQL/enquiry) → the vendor rep or FarmX specialist;
  - SLA: acknowledge within 2 working hours;
  - masked calling; 30-day conversion attribution; vendors see only their own leads.

**Engagement and internal**

- **Content:** news cards (disease alerts, prices, regulation) in English and Telugu, targeted,
  with a CTA; sponsored cards labelled and capped.
- **Support:** one ticket queue across in-app, phone, email and WhatsApp, with full context; SLAs
  and escalation to a vet; tele-caller outbound queue.
- **Field sales:** territory workspace, geo check-in visits, assisted orders at the published
  price (customer OTP), lead routing.
- **HR and payroll:** staff, attendance, leave and payroll (scope to be confirmed).
- **Notifications:** SMS (DLT), WhatsApp, email, push, in-app and voice, driven by an event matrix.
  Marketing sends are consent-based; transactional sends are never suppressed.
- **Reports and dashboards:** vendor ERP dashboard (consignment donut, live stock, finance,
  expiry, demand); internal KPIs; exports.

## 2. Key flows

- **Customer:**
  - register (path) → Farm ID → browse/search → product (tier price, stock, ETA);
  - cart (revalidated) → checkout (unit, address, GSTIN) → Razorpay → order confirmed;
  - allocated → picked → dispatched → tracking → **delivery OTP + photo**;
  - delivered (COA link) → tele-caller confirmation → closed → QR scan into the farm software.
- **Prescription:** book a consultation → vet workspace → prescription (withdrawal period) →
  one-tap cart → checkout → dispensed quantity updated → auto-repeat order.
- **Sales call:** product page → Book a Sales Call (slot and consent) → lead scored and routed →
  rep acknowledges within 2 hours → masked call → disposition → on-platform order attributed.
- **Vendor:**
  - apply → verification (Category Manager, then Super Admin) → portal login (forced password
    change and MFA);
  - submit product info → FarmX creates items → vendor verifies;
  - PO → consignment → receipt acknowledgement → sale → **same-day settlement** → statement.
- **Admin / ops:**
  - approvals inbox: vendors, catalogue, price tiers, POs, liquidation, ads, refunds, quarantine
    release, payouts, roles;
  - order exceptions; quality holds; recall.
- **Warehouse:** gate entry → receipt (unit QR) → put-away → FEFO pick → pack (cold chain) →
  dispatch checklist → manifest/gate scan.
- **Driver:** OTP login → start shift (vehicle checklist) → pickup custody → route →
  arrival/geofence → OTP + photos + line receipt (or failure) → sync → end shift → earnings.

## 3. Screen → API mapping (from the available screens)

| Screen                                                                             | APIs                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Onboarding 6–10/60–66, Create PIN, Fingerprint, Farm verification, Farm location   | `/auth/otp/*`, `/auth/register`, `/me/pin`, `/farms` (POST), `/farms/{id}/location`, `/kyc/documents`                                                        |
| Home, Product page, States/Empty                                                   | `/home`, `/catalog/search`, `/catalog/products/{id}`, `/pricing/resolve`                                                                                     |
| C-07c Cart, Coupon view, C-13b Offers                                              | `/cart`, `/cart/items`, `/cart/coupons`, `/offers?orderId=`                                                                                                  |
| Checkout, C-14a Pay, UPI options, Retry payment, Success/Failed/Pending            | `/checkout`, `/orders`, `/payments/{orderId}/intent`, `/payments/{id}/retry`, `/payments/{id}`                                                               |
| C-17a Orders, C-17b Order detail, Invoices                                         | `/orders`, `/orders/{id}`, `/orders/{id}/invoices`                                                                                                           |
| C-17c Live tracking, C-17d Delivery OTP                                            | `/orders/{id}/tracking`, `/consignments/{id}/otp` (customer view)                                                                                            |
| C-18a Delivered, C-18b Report a problem, C-18c Return, Cancellation                | `/orders/{id}/receipt`, `/returns` (POST), `/returns/{id}`, `/orders/{id}/cancel`                                                                            |
| C-18d Scheduled & recurring                                                        | `/recurring-orders` CRUD, `/recurring-orders/{id}/skip`                                                                                                      |
| C-12a/d/e Book a Sales Call                                                        | `/leads/slots`, `/leads` (POST, consent), `/leads/{id}`                                                                                                      |
| C-16b Membership, C-16c Points & wallet, Add money, Refer & earn, Points converted | `/loyalty/me`, `/loyalty/points`, `/wallet`, `/wallet/topups`, `/referrals`                                                                                  |
| Scan COA, Scanning, Details, Hatchery details                                      | `/coa/{consignmentNo}`, `/trace/qr/{code}`, `/farms/{id}`                                                                                                    |
| Profile, Settings, Address, Privacy & consent, Delete account, Sign out            | `/me`, `/me/addresses`, `/me/consents`, `/me/deletion-request`, `/auth/logout`                                                                               |
| C-27b New ticket, FAQ                                                              | `/support/tickets`, `/content/faq`                                                                                                                           |
| Driver D-01…D-13                                                                   | `/auth/otp/*`, `/me/shift/today`, `/shifts`, `/consignments/{id}/custody`, `/consignments/{id}/pod`, `/failures`, `/sync/events`, `/payouts/ledger`          |
| Warehouse W-01…W-06                                                                | `/pick-lists`, `/consignments/{id}/pick`, `/pack`, `/dispatch`, `/manifests/{id}/gate-scan`, `/receipts`                                                     |
| Control tower C-01…C-06, QA Q-01…Q-06                                              | `/consignments`, `/trips`, `/exceptions/{id}/decision`, `/telemetry`, `/alerts`, `/holds`, `/deviations`, `/trace/batch/{id}`, `/recalls`, `/kpis`, `/audit` |
| Admin console (all 24 sidebar modules)                                             | Each module follows the list / detail / create-edit / status-workflow / audit pattern: `/admin/<module>`                                                     |

## 4. Business rules (must enforce)

- **Price resolution** (BL-02), in fixed order: list rate → volume tier → expiry/clearance
  discount → membership → one campaign plus one coupon (the greater wins) → combo overrides →
  GST. Persist the trace. **Ads never change the price.**
- **Prepaid only:**
  - an order confirms only on realised payment;
  - there is no credit-hold state and no customer credit field;
  - payment status is read-only in logistics.
- **Stock:**
  - FEFO allocation; no manual batch choice;
  - quarantined, expired or failed batches are excluded;
  - only P8 adjusts stock or releases quarantine (with evidence).
- **Node routing by pin code** (primary and alternates); node failover; a weather-hold state when
  all nodes are down.
- **Expiry and returns:**
  - expiry ladder at 90/60/30 days, vendor-funded; expired stock is blocked;
  - day-150 flag, day-180 return proposal, storage fees after 15 days' grace.
- **Settlement:** only on confirmed fulfilment, in the same working day's run; reversals need P8.
- **Prescriptions:**
  - an Rx item needs a valid prescription for that Farm ID; dispensing decrements it;
  - auto-repeat is never indefinite;
  - **vet pay is never linked to products prescribed**, and ads and leads never touch Rx screens.
- **Delivery:** needs the farm OTP (support override is documented). Delivery status and quality
  status are separate. A failed COA quarantines the whole consignment.
- **Ads:** an ad serves only if:
  - the booking is authorized and the creative validated;
  - the slot-day is paid and the product is active and in stock;
  - vendor licences are valid and the audience minimum is met.
- **Lead attribution:** an order within 30 days counts for the lead; an ad click within 7 days
  counts for the ad; lead attribution takes precedence.
- **Segregation of duties:** the ad authorizer ≠ the creative validator; no approving your own
  financial, quality or access request.
- **Data:** India-resident; DPDP consent and purpose limitation; statutory retention; RPO 15 min,
  RTO 4 h.

## 5. Edge cases

- Price or stock changed between cart and checkout: revalidate and notify; never silently charge
  a different amount.
- Payment webhook duplicated, late, or arriving after the reservation timed out: process
  idempotently and re-reserve or refund.
- Split shipments across nodes, including cold and ambient lines in one order.
- Partial delivery, refusal or absence: child return consignment; cold items limited by
  remaining transit time.
- Offline POD with no OTP: `delivered_pending_verification` until LOG approves.
- Prescription expires mid-cart, or an item is out of stock: same-molecule substitution, flagged.
- COA missing: say so with an expected date and a notify-me option. COA fails after delivery:
  recall flow.
- Vendor licence expires while ads are live: auto-pause and credit lost slot-days.
- Duplicate farm registration (mobile, PAN, GSTIN, geo): manual review queue.
- All four coastal nodes down (cyclone): weather hold, released in expiry/priority order.
- Settlement exposure above the ceiling: alert the MD.

## 6. Open questions / missing requirements

- **Design books** (Parts 2–4) and the Logistics UI HTML could not be read: they are image-only or
  script-rendered. The admin, vendor and warehouse screen lists are unconfirmed.
- **Consolidated document:** Section 24 (launch conditions L1–L12, NFR list) is cut off in the
  PDF; the NFRs were taken from PRD Vol. I.
- **Customer login:** OTP-first (backend scope doc) versus password + OTP (FR-REG-15/17).
- **Phase 1 cut:** R1 lists every "M" requirement, including ads, liquidation and leads. Which
  service build order?
- **Accounting:** in-house books versus an external package (not chosen); HR/payroll in scope or
  not.
- **External systems:** Interferon Labs LIMS and the FarmX farm management software — do the APIs
  exist?
- **Vendors not chosen:** SMS/WhatsApp provider, telephony masking, video consults, e-sign,
  Aadhaar verification, logger hardware.
- **Logistics:** fleet model per depot (own, partner or 3PL); delivery promise per zone; whether
  frozen (CC-FRZ) products are listed.
- **Retention and backup:** retention periods (QAM/legal); cloud account opened in FarmX's name.
