# 07 · farm-service — Implementation Plan

_Status: **P0–P4 built** (2026-11-13), not yet run against Postgres (Docker down). Remaining: P5 delegates
(needs auth `POST /internal/users`), P6 farm profile, assisted registration (A5), exports (A16), signed
document view (A12, needs private media), `user.deleted.v1` consumer, k6 load test._

**Implementation notes (differences from the plan below):**

- No `SUBMITTED` status: submit goes straight to `ACTIVE` or `UNDER_REVIEW` in one transaction.
- Domain error codes travel as `error.details.reason` on the standard 409/422/403 (e.g.
  `FARM_STATE_INVALID`, `FARM_VERSION_CONFLICT`, `DRAFT_LIMIT_REACHED`, `SOD_VIOLATION`);
  version conflicts answer **409** (412 is not in the shared error set).
- Extra routes: `DELETE /farms/{id}` (discard draft), `POST /farms/{id}/kyc/defer`.
- Owner `phone` is null until a user read model exists (auth owns phone numbers).
- Admin actions are separate routes: `POST /admin/farms/{id}/{suspend|reactivate|close|reject|request-changes}`.

Sources: `Documents/FarmX Marketplace_farm/*.png`
(14 screens), [PROJECT_CONTEXT](../docs/PROJECT_CONTEXT.md) §1 Identity/onboarding, [API_PLAN](../docs/API_PLAN.md) §2,
[decisions](../docs/decisions.md) D-07/D-15/D-16/D-17/D-18/D-20/D-21, `services/_template`.

**Scope:** farm owners, farm units, Farm ID, location/territory, KYC (Aadhaar OTP, PAN, GSTIN,
documents), duplicate review, delegates, farm profile (sheds/flocks), admin management.
**Out of scope:** vendors (own service later), orders/Rx/loyalty (they consume farm events).

---

## 0. Targets

| Target                                                                          | Budget (p95, server time, warm) | How                                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Hot reads (`GET /farms`, `/farms/{id}`, `/pass`, pincode lookup, `/internal/*`) | **< 50 ms** (cache hit < 10 ms) | Redis read-through + in-process LRU for reference data, column-pruned queries, fast-json-stringify response schemas |
| Writes + admin list/search                                                      | **< 200 ms**                    | single transaction, covering/partial indexes, no external calls in the request path, side effects after commit      |
| External-bound (Aadhaar OTP, GST verify)                                        | < 2.5 s, hard timeout 3 s       | excluded from the 200 ms SLO; timeout + circuit breaker + 24 h result cache                                         |

Security baseline: default-deny, own-records-only (404 on others' ids), PII encrypted/masked,
every admin write audited in the same transaction, idempotent POSTs, optimistic concurrency.

---

## 1. Screen → flow → API

| #   | Screen                                                                                              | Step | API (public, via gateway)                                                              |
| --- | --------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| 1   | Choose category ("What do you run?")                                                                | 1/5  | `GET /v1/farms/categories` · `POST /v1/farms` (draft)                                  |
| 1b  | Backyard quick sign-up                                                                              | —    | `POST /v1/farms/quick` → active immediately                                            |
| 2   | Farm Details (name, owner, production types ranked 1st/2nd, capacity per type)                      | 2/5  | `PATCH /v1/farms/{id}/details`                                                         |
| 2b  | Hatchery Details (eggs/setting, feed tonnes/month, Farm ID preview)                                 | 2/5  | `PATCH /v1/farms/{id}/details` · preview from `GET /v1/farms/{id}` (`farmCodePreview`) |
| 3   | Farm Location (GPS ±m, village, pin → district/mandal/territory/node/promise)                       | 3/5  | `GET /v1/farms/geo/pincodes/{pin}` · `PUT /v1/farms/{id}/location`                     |
| 4   | Documentation / Aadhaar consent sheet                                                               | 4/5  | `POST …/kyc/aadhaar/otp` · `POST …/kyc/aadhaar/verify`                                 |
| 4b  | Business Documents (PAN upload, GSTIN + portal check, invoice-name choice, "Skip and verify later") | 4/5  | `PUT …/kyc/pan` · `POST …/kyc/documents` · `POST …/kyc/gstin/verify` · `PUT …/billing` |
| 5   | Owner & Review (age band, personalised-tips consent, permanent-ID acknowledgement)                  | 5/5  | `PATCH /v1/farms/{id}/owner` · `POST /v1/farms/{id}/submit`                            |
| 6   | Farm ID ready (Farm pass + QR, share, "attached to this ID")                                        | —    | `GET /v1/farms/{id}/pass`                                                              |
| 7   | Verification · Under review ("separate unit?" + timeline)                                           | —    | `GET /v1/farms/{id}/verification` · `POST …/verification/claim`                        |
| 8   | Verification failed (per-document issues, Fix & Resubmit)                                           | —    | `GET …/verification` · `POST …/kyc/documents` · `POST …/resubmit`                      |

```
Customer (OTP-logged-in, typ=CUSTOMER)
 └─ category ─► DRAFT ─► details ─► location ─► KYC (or skip) ─► owner/consent ─► SUBMIT
                                                                                   │
                     dedupe (PAN-hash, GSTIN, geo ≤150 m, name trigram) ──────────┤
                        no match ─► ACTIVE + Farm ID issued ─► farm.activated.v1 ─► SMS/WhatsApp pass
                        match    ─► UNDER_REVIEW + DuplicateCase ─► owner claim ─► admin decision
                                       ├─ APPROVE_SEPARATE ─► ACTIVE + Farm ID
                                       ├─ MERGE ─► MERGED (linked to existing Farm ID)
                                       └─ REQUEST_CHANGES ─► NEEDS_ATTENTION ─► fix ─► resubmit
```

---

## 2. Domain rules

1. **Farm ID** = `FX-{territoryCode}-{typeCode}-{serial:05}` e.g. `FX-WG-L-00418`.
   - `typeCode` from the **primary** (rank 1) production type: LAYER `L` · BROILER `B` ·
     BROILER_BREEDER `BB` · LAYER_BREEDER `LB` · HATCHERY `H` · FEED_MILL `FM` · BACKYARD `R`.
   - `territoryCode` from the pin code at activation. Serial per (territory, type) from
     `farm_id_sequences` (`INSERT … ON CONFLICT DO UPDATE SET lastValue = lastValue + 1 RETURNING`,
     inside the activation transaction; row lock is per territory+type only). Overflow → 6 digits.
   - Issued **only** on activation; **immutable** (DB trigger, SQLSTATE 42501). Moving the farm
     never changes it. A wrong code is fixed by close + new farm, never by edit.
   - Draft shows a `farmCodePreview` (`FX-WG-L-•••••`) only.
2. **One owner (PAN/person) → many farm units.** A second site gets its own Farm ID and shares
   the owner (loyalty tier keys on `ownerId`).
3. **KYC can be deferred** for business categories ("Skip and verify later"): Farm ID is issued,
   `owner.kycStatus = PENDING`; GST invoicing, Rx purchase and orders above a configurable value are
   gated by other services reading `kycStatus`. BACKYARD needs no KYC.
4. **Aadhaar is never stored**: only last 4 digits, provider reference id, verified-at, name-match
   result. The number exists only in request memory and is redacted from logs.
5. **Dedupe on submit** (one round trip, all indexed, < 20 ms):

   | Signal              | Rule                                                   | Weight                     |
   | ------------------- | ------------------------------------------------------ | -------------------------- |
   | `PAN_OTHER_OWNER`   | `panHash` equals another owner's                       | 60                         |
   | `GSTIN_OTHER_OWNER` | GSTIN on another owner's non-closed farm               | 60                         |
   | `GEO_SAME_OWNER`    | own active farm within `DEDUPE_RADIUS_M` (150)         | 40 (asks "separate unit?") |
   | `GEO_NAME`          | other owner within 150 m **and** name similarity ≥ 0.6 | 40                         |

   Any signal → `UNDER_REVIEW`. Matched farm name/code is shown to the customer **only** for
   same-owner matches (`GEO_SAME_OWNER` / same `panHash`); otherwise a generic message (no data leak).

6. **Editable after activation:** capacities, address line, sheds/flocks. **Locked:** farm name and
   owner name (lock icon in UI) → admin correction with reason. Location move > 500 m → re-review.
7. **Segregation of duties:** a reviewer can't decide a case on a farm they registered
   (`createdByUserId`) or own.
8. All status changes go through the state machine (§4); each writes `farm_status_events`.

---

## 3. Data model (`packages/database/prisma/schema/farm/`)

Conventions (D-21 / CLAUDE.md): UUID v7 ids, camelCase columns, snake_case tables, money
`Decimal(14,2)`, no Prisma relations across **features**, soft delete, `version` for optimistic locking.

### 3.1 `farm/farms.prisma` — feature `farms`

```prisma
enum FarmCategory      { POULTRY_FARM HATCHERY FEED_MILL BACKYARD }
enum ProductionType    { LAYER BROILER BROILER_BREEDER LAYER_BREEDER HATCHERY FEED_MILL BACKYARD }
enum FarmStatus        { DRAFT SUBMITTED UNDER_REVIEW NEEDS_ATTENTION ACTIVE SUSPENDED REJECTED MERGED CLOSED }
enum KycStatus         { NOT_STARTED PENDING VERIFIED REJECTED }
enum CapacityMetric    { BIRDS EGGS FEED_TONNES }
enum CapacityPeriod    { STANDING PER_CYCLE PER_SETTING PER_WEEK PER_HOUR PER_DAY PER_MONTH }
enum InvoiceNameSource { FARM_NAME GST_TRADE_NAME }
enum AgeBand           { AGE_18_30 AGE_31_45 AGE_46_60 AGE_60_PLUS }
enum RegistrationChannel { SELF FIELD_ASSISTED ADMIN IMPORT }
enum ActorType         { OWNER MEMBER ADMIN SYSTEM }

model FarmOwner {
  id                 String    @id @default(uuid(7)) @db.Uuid
  userId             String    @unique @db.Uuid          /// auth users.id (no FK, D-16)
  fullName           String    @db.VarChar(120)
  phone              String    @db.VarChar(15)           /// E.164 snapshot (verified by auth OTP)
  ageBand            AgeBand?
  preferredLanguage  String    @default("en") @db.VarChar(5)
  // PAN — encrypted at app layer (AES-256-GCM), HMAC for lookup/dedupe, never logged
  panCipher          Bytes?                              /// iv(12) | tag(16) | ciphertext
  panKeyId           Int?      @db.SmallInt              /// key rotation
  panHash            Bytes?                              /// HMAC-SHA256(pepper, PAN)
  panMasked          String?   @db.VarChar(10)           /// AKLPK****Q
  panNameMatch       Boolean?
  panVerifiedAt      DateTime?
  // Aadhaar — result only (rule 4)
  aadhaarLast4       String?   @db.Char(4)
  aadhaarRefId       String?   @db.VarChar(64)           /// provider reference, not the number
  aadhaarNameMatch   Boolean?
  aadhaarVerifiedAt  DateTime?
  kycStatus          KycStatus @default(NOT_STARTED)
  kycStatusChangedAt DateTime?
  version            Int       @default(0)
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  deletedAt          DateTime?

  farms    Farm[]
  consents OwnerConsent[]

  @@index([panHash])
  @@index([phone])
  @@index([kycStatus, kycStatusChangedAt])
  @@map("farm_owners")
}

model Farm {
  id                    String              @id @default(uuid(7)) @db.Uuid
  farmCode              String?             @unique @db.VarChar(24)  /// FX-WG-L-00418, immutable (trigger)
  ownerId               String              @db.Uuid
  category              FarmCategory
  primaryProductionType ProductionType?
  productionTypes       ProductionType[]                             /// ordered, [0] = primary
  name                  String              @db.VarChar(120)
  nameNormalized        String              @db.VarChar(120)         /// lower/trim/collapse — dedupe & search
  // billing
  gstin                 String?             @db.Char(15)
  gstVerificationId     String?             @db.Uuid                 /// kyc feature (plain id)
  invoiceNameSource     InvoiceNameSource   @default(FARM_NAME)
  invoiceName           String?             @db.VarChar(160)         /// resolved snapshot
  // location
  latitude              Decimal?            @db.Decimal(9, 6)
  longitude             Decimal?            @db.Decimal(9, 6)
  gpsAccuracyM          Int?                @db.SmallInt
  locationCapturedAt    DateTime?
  addressLine           String?             @db.VarChar(200)
  village               String?             @db.VarChar(80)
  pinCode               String?             @db.Char(6)
  territoryId           String?             @db.Uuid                 /// geo feature (plain id)
  territoryCode         String?             @db.VarChar(3)           /// snapshot used for farmCode
  districtName          String?             @db.VarChar(80)
  mandalName            String?             @db.VarChar(80)
  primaryNodeId         String?             @db.Uuid
  backupNodeId          String?             @db.Uuid
  totalBirdCapacity     Int?                                         /// denormalised sum (pass/list)
  // lifecycle
  status                FarmStatus          @default(DRAFT)
  statusReasonCode      String?             @db.VarChar(40)
  statusReason          String?             @db.VarChar(500)
  statusChangedAt       DateTime            @default(now())
  registrationStep      Int                 @default(1) @db.SmallInt /// resume point 1..5
  kycDeferredAt         DateTime?
  permanentIdAckAt      DateTime?                                    /// "I understand…" checkbox
  submittedAt           DateTime?
  activatedAt           DateTime?                                    /// "Member since"
  mergedIntoFarmId      String?             @db.Uuid
  channel               RegistrationChannel @default(SELF)
  createdByUserId       String              @db.Uuid
  version               Int                 @default(0)
  createdAt             DateTime            @default(now())
  updatedAt             DateTime            @updatedAt
  deletedAt             DateTime?

  owner        FarmOwner         @relation(fields: [ownerId], references: [id])
  capacities   FarmCapacity[]
  statusEvents FarmStatusEvent[]

  @@index([ownerId, status])
  @@index([territoryId, status, id])
  @@index([category, status, id])
  @@index([pinCode])
  @@index([gstin])
  @@map("farms")
  // raw SQL migration: partial review-queue index, GIN trigram on nameNormalized,
  // GiST earthdistance on (latitude, longitude), CHECKs, immutability trigger (§3.8)
}

model FarmCapacity {
  id             String         @id @default(uuid(7)) @db.Uuid
  farmId         String         @db.Uuid
  productionType ProductionType
  metric         CapacityMetric
  value          Decimal        @db.Decimal(14, 2)   /// birds, eggs, tonnes
  period         CapacityPeriod
  rank           Int            @db.SmallInt          /// 1 = primary (UI "1st")
  updatedAt      DateTime       @updatedAt

  farm Farm @relation(fields: [farmId], references: [id], onDelete: Cascade)

  @@unique([farmId, productionType, metric])
  @@map("farm_capacities")
}

model FarmStatusEvent {                    /// append-only (trigger)
  id          String      @id @default(uuid(7)) @db.Uuid
  farmId      String      @db.Uuid
  fromStatus  FarmStatus?
  toStatus    FarmStatus
  reasonCode  String?     @db.VarChar(40)
  reason      String?     @db.VarChar(500)
  actorType   ActorType
  actorUserId String?     @db.Uuid
  metadata    Json        @default("{}")
  requestId   String?     @db.VarChar(64)
  createdAt   DateTime    @default(now())

  farm Farm @relation(fields: [farmId], references: [id])

  @@index([farmId, createdAt])
  @@map("farm_status_events")
}

model FarmIdSequence {
  territoryCode String   @db.VarChar(3)
  typeCode      String   @db.VarChar(2)
  lastValue     Int      @default(0)
  updatedAt     DateTime @updatedAt

  @@id([territoryCode, typeCode])
  @@map("farm_id_sequences")
}

enum ConsentPurpose { PERSONALIZED_OFFERS AADHAAR_EKYC MARKETING_SMS MARKETING_WHATSAPP }

model OwnerConsent {                       /// append-only DPDP ledger; latest row per purpose wins
  id            String         @id @default(uuid(7)) @db.Uuid
  ownerId       String         @db.Uuid
  purpose       ConsentPurpose
  granted       Boolean
  noticeVersion String         @db.VarChar(20)
  channel       String         @db.VarChar(20)    /// app | field | admin
  ip            String?        @db.VarChar(45)
  createdAt     DateTime       @default(now())

  owner FarmOwner @relation(fields: [ownerId], references: [id])

  @@index([ownerId, purpose, createdAt(sort: Desc)])
  @@map("farm_owner_consents")
}
```

### 3.2 `farm/geo.prisma` — feature `geo` (interim owner until logistics-service; then event-fed)

```prisma
model Territory {
  id           String   @id @default(uuid(7)) @db.Uuid
  code         String   @unique @db.VarChar(3)     /// WG, EG, KR …
  name         String   @db.VarChar(80)            /// West Godavari
  districtName String   @db.VarChar(80)
  stateCode    String   @db.Char(2)                /// AP
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@map("territories")
}

model PinCode {
  pinCode         String   @id @db.Char(6)
  territoryId     String   @db.Uuid
  districtName    String   @db.VarChar(80)
  mandalName      String?  @db.VarChar(80)
  villages        String[]                          /// suggestions for the Village field
  primaryNodeId   String?  @db.Uuid
  primaryNodeName String?  @db.VarChar(80)          /// "Mother WH (Eluru)"
  backupNodeId    String?  @db.Uuid
  backupNodeName  String?  @db.VarChar(80)          /// "Tanuku C&F"
  deliveryPromise String?  @db.VarChar(40)          /// "Next-day delivery"
  serviceable     Boolean  @default(true)
  updatedAt       DateTime @updatedAt
  @@index([territoryId])
  @@map("pin_codes")
}
```

### 3.3 `farm/kyc.prisma` — feature `kyc`

```prisma
enum KycDocType       { PAN_CARD GST_CERTIFICATE ID_PROOF_FRONT ID_PROOF_BACK TRADE_LICENCE OTHER }
enum KycDocStatus     { UPLOADED ACCEPTED REJECTED SUPERSEDED }
enum GstPortalStatus  { ACTIVE CANCELLED SUSPENDED INACTIVE }

model KycDocument {
  id               String       @id @default(uuid(7)) @db.Uuid
  ownerId          String       @db.Uuid
  farmId           String?      @db.Uuid
  docType          KycDocType
  storageKey       String       @db.VarChar(300)   /// media-service PRIVATE object key (never a public URL)
  contentType      String       @db.VarChar(60)
  sizeBytes        Int
  sha256           String       @db.Char(64)
  status           KycDocStatus @default(UPLOADED)
  rejectionCode    String?      @db.VarChar(40)    /// BLURRY, MISMATCH, EXPIRED, INCOMPLETE …
  rejectionNote    String?      @db.VarChar(300)   /// "Text on the back of your ID is illegible"
  reviewedByUserId String?      @db.Uuid
  reviewedAt       DateTime?
  uploadedByUserId String       @db.Uuid
  createdAt        DateTime     @default(now())
  @@index([ownerId, docType, createdAt(sort: Desc)])
  @@index([status, createdAt])
  @@map("kyc_documents")
}

model GstVerification {
  id              String          @id @default(uuid(7)) @db.Uuid
  gstin           String          @db.Char(15)
  tradeName       String?         @db.VarChar(200)
  legalName       String          @db.VarChar(200)
  portalStatus    GstPortalStatus
  stateCode       String          @db.Char(2)
  registeredOn    DateTime?       @db.Date
  provider        String          @db.VarChar(30)
  requestedBy     String          @db.Uuid
  checkedAt       DateTime        @default(now())
  @@index([gstin, checkedAt(sort: Desc)])
  @@map("gst_verifications")
}
```

### 3.4 `farm/review.prisma` — feature `review`

```prisma
enum DuplicateSignal { PAN_OTHER_OWNER GSTIN_OTHER_OWNER GEO_SAME_OWNER GEO_NAME }
enum OwnerClaim      { SEPARATE_UNIT SAME_FARM }
enum CaseStatus      { OPEN IN_REVIEW RESOLVED_SEPARATE RESOLVED_MERGED RESOLVED_CHANGES RESOLVED_REJECTED }

model DuplicateCase {
  id               String            @id @default(uuid(7)) @db.Uuid
  farmId           String            @db.Uuid
  matchedFarmId    String            @db.Uuid
  matchedOwnerId   String            @db.Uuid
  signals          DuplicateSignal[]
  score            Int               @db.SmallInt
  distanceM        Int?
  nameSimilarity   Decimal?          @db.Decimal(4, 3)
  ownerClaim       OwnerClaim?
  ownerClaimAt     DateTime?
  status           CaseStatus        @default(OPEN)
  assignedToUserId String?           @db.Uuid
  assignedAt       DateTime?
  slaDueAt         DateTime
  resolvedByUserId String?           @db.Uuid
  resolvedAt       DateTime?
  resolutionNote   String?           @db.VarChar(500)
  version          Int               @default(0)
  createdAt        DateTime          @default(now())
  updatedAt        DateTime          @updatedAt
  @@index([farmId])
  @@map("farm_duplicate_cases")
  // raw: partial index (status, slaDueAt) WHERE status IN ('OPEN','IN_REVIEW')
}
```

### 3.5 `farm/members.prisma` — feature `members` (delegate logins, FR-REG-19)

```prisma
enum MemberRole   { OWNER SUPERVISOR }
enum MemberStatus { ACTIVE REVOKED }

model FarmMember {
  id              String       @id @default(uuid(7)) @db.Uuid
  farmId          String       @db.Uuid
  userId          String       @db.Uuid
  role            MemberRole
  orderLimit      Decimal?     @db.Decimal(14, 2)   /// per-order ceiling for SUPERVISOR
  status          MemberStatus @default(ACTIVE)
  invitedByUserId String       @db.Uuid
  createdAt       DateTime     @default(now())
  revokedAt       DateTime?
  @@unique([farmId, userId])
  @@index([userId, status])
  @@map("farm_members")
}
```

### 3.6 `farm/profile.prisma` — feature `profile` (Phase 6, priority S)

```prisma
enum HousingType { OPEN_SIDED CONTROLLED CAGE DEEP_LITTER }
enum FlockStatus { ACTIVE DEPLETED }

model Shed {
  id             String         @id @default(uuid(7)) @db.Uuid
  farmId         String         @db.Uuid
  code           String         @db.VarChar(10)     /// S1 … ("Shed 1-4" on pass)
  name           String?        @db.VarChar(60)
  productionType ProductionType
  housingType    HousingType?
  capacityBirds  Int
  isActive       Boolean        @default(true)
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
  @@unique([farmId, code])
  @@map("farm_sheds")
}

model Flock {
  id              String         @id @default(uuid(7)) @db.Uuid
  farmId          String         @db.Uuid
  shedId          String         @db.Uuid
  productionType  ProductionType
  breed           String?        @db.VarChar(60)
  placedOn        DateTime       @db.Date
  ageDaysAtPlace  Int            @db.SmallInt
  placedCount     Int
  currentCount    Int
  status          FlockStatus    @default(ACTIVE)
  depletedOn      DateTime?      @db.Date
  clientMutationId String?       @unique @db.Uuid   /// offline idempotency
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  @@index([farmId, status])
  @@map("farm_flocks")
}

model HealthRecord {                 /// vaccination + disease history
  id               String   @id @default(uuid(7)) @db.Uuid
  farmId           String   @db.Uuid
  flockId          String   @db.Uuid
  kind             String   @db.VarChar(20)        /// VACCINATION | DISEASE | MORTALITY
  title            String   @db.VarChar(120)       /// vaccine or disease name
  productId        String?  @db.Uuid               /// catalogue variant if bought on FarmX
  batchNo          String?  @db.VarChar(40)
  dose             String?  @db.VarChar(40)
  route            String?  @db.VarChar(20)
  count            Int?
  occurredOn       DateTime @db.Date
  notes            String?  @db.VarChar(500)
  recordedByUserId String   @db.Uuid
  clientMutationId String?  @unique @db.Uuid
  createdAt        DateTime @default(now())
  @@index([flockId, occurredOn])
  @@map("farm_health_records")
}

model FarmPhoto {
  id          String   @id @default(uuid(7)) @db.Uuid
  farmId      String   @db.Uuid
  storageKey  String   @db.VarChar(300)
  latitude    Decimal  @db.Decimal(9, 6)
  longitude   Decimal  @db.Decimal(9, 6)
  takenAt     DateTime
  caption     String?  @db.VarChar(120)
  createdAt   DateTime @default(now())
  @@index([farmId, takenAt])
  @@map("farm_photos")
}

model FarmProfileVersion {           /// append-only snapshot per profile change
  id              String   @id @default(uuid(7)) @db.Uuid
  farmId          String   @db.Uuid
  version         Int
  snapshot        Json
  changedFields   String[]
  changedByUserId String   @db.Uuid
  createdAt       DateTime @default(now())
  @@unique([farmId, version])
  @@map("farm_profile_versions")
}
```

### 3.7 `farm/audit.prisma` — feature `audit` (proposed D-22)

```prisma
model FarmAuditLog {                 /// same shape as admin_audit_log; append-only
  id          String   @id @default(uuid(7)) @db.Uuid
  actorUserId String   @db.Uuid
  action      String   @db.VarChar(60)    /// farm.suspend, kyc.document.reject, pii.reveal …
  targetType  String   @db.VarChar(30)    /// farm | owner | case | document | pincode
  targetId    String   @db.VarChar(64)
  before      Json?
  after       Json?
  reason      String?  @db.VarChar(500)
  metadata    Json     @default("{}")
  ip          String?  @db.VarChar(45)
  requestId   String?  @db.VarChar(64)
  createdAt   DateTime @default(now())
  @@index([targetType, targetId, createdAt])
  @@index([actorUserId, createdAt])
  @@map("farm_audit_log")
}
```

### 3.8 Raw SQL migration (same migration, after Prisma DDL)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

CREATE INDEX farms_name_trgm   ON farms USING gin ("nameNormalized" gin_trgm_ops);
CREATE INDEX farms_geo_gist    ON farms USING gist (ll_to_earth(latitude::float8, longitude::float8))
  WHERE latitude IS NOT NULL AND status NOT IN ('DRAFT','REJECTED','CLOSED');
CREATE INDEX farms_review_q    ON farms (status, "submittedAt") WHERE status IN ('SUBMITTED','UNDER_REVIEW','NEEDS_ATTENTION');
CREATE INDEX farms_code_trgm   ON farms USING gin ("farmCode" gin_trgm_ops);   -- admin search by partial code
CREATE INDEX cases_open        ON farm_duplicate_cases (status, "slaDueAt") WHERE status IN ('OPEN','IN_REVIEW');

ALTER TABLE farms ADD CONSTRAINT farms_lat CHECK (latitude  IS NULL OR latitude  BETWEEN 6.5 AND 37.5);
ALTER TABLE farms ADD CONSTRAINT farms_lng CHECK (longitude IS NULL OR longitude BETWEEN 68 AND 97.5);
ALTER TABLE farms ADD CONSTRAINT farms_active_has_code CHECK (status NOT IN ('ACTIVE','SUSPENDED') OR "farmCode" IS NOT NULL);
ALTER TABLE farm_capacities ADD CONSTRAINT cap_positive CHECK (value > 0);

-- Farm ID immutable once issued
CREATE FUNCTION farms_code_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."farmCode" IS NOT NULL AND NEW."farmCode" IS DISTINCT FROM OLD."farmCode" THEN
    RAISE EXCEPTION 'farmCode is immutable' USING ERRCODE = '42501';
  END IF; RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER farms_code_immutable BEFORE UPDATE ON farms FOR EACH ROW EXECUTE FUNCTION farms_code_immutable();

-- Append-only (reuse the D-15 function): farm_status_events, farm_owner_consents,
-- farm_audit_log, farm_profile_versions → BEFORE UPDATE/DELETE/TRUNCATE raise 42501;
-- REVOKE UPDATE, DELETE, TRUNCATE on them from the app role in roles.sql.
```

Dedupe query (repository, `$queryRaw`, uses the GiST index):
`… WHERE earth_box(ll_to_earth($lat,$lng), $r) @> ll_to_earth(lat,lng) AND earth_distance(…) <= $r`
plus `similarity("nameNormalized", $name)`; PAN/GSTIN checks are equality on indexed columns,
all `UNION ALL` in one statement, `LIMIT 5`.

---

## 4. State machine (`farms/farm.state.ts`, pure function + unit tests)

| From                    | Event                                         | To                                   | Actor                                                | Side effects                                                        |
| ----------------------- | --------------------------------------------- | ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------- |
| —                       | create                                        | DRAFT                                | OWNER / field / admin                                | —                                                                   |
| DRAFT, NEEDS_ATTENTION  | submit / resubmit                             | SUBMITTED → (ACTIVE \| UNDER_REVIEW) | OWNER                                                | dedupe; Farm ID on ACTIVE; `farm.submitted.v1`, `farm.activated.v1` |
| UNDER_REVIEW            | decision APPROVE_SEPARATE                     | ACTIVE                               | ADMIN (`customers.verify`)                           | Farm ID issued                                                      |
| UNDER_REVIEW            | decision MERGE / claim SAME_FARM (same owner) | MERGED                               | ADMIN / OWNER                                        | `mergedIntoFarmId`; `farm.merged.v1`                                |
| UNDER_REVIEW, SUBMITTED | request changes                               | NEEDS_ATTENTION                      | ADMIN                                                | `farm.needs_attention.v1` (issues)                                  |
| UNDER_REVIEW            | reject                                        | REJECTED                             | ADMIN                                                | reason required                                                     |
| ACTIVE                  | suspend                                       | SUSPENDED                            | ADMIN (`customers.suspend`)                          | reason; events                                                      |
| SUSPENDED               | reactivate                                    | ACTIVE                               | ADMIN (`customers.suspend`)                          | reason                                                              |
| ACTIVE, SUSPENDED       | close                                         | CLOSED                               | OWNER (no open orders, via event read model) / ADMIN | code retired, never reused                                          |
| DRAFT                   | expire (job, 30 d idle)                       | soft-deleted                         | SYSTEM                                               | —                                                                   |

Any other transition → `409 FARM_STATE_INVALID`.

---

## 5. Customer APIs — `/v1/farms` (gateway `/v1/farms` → service `/farms`)

All: `requireAuth` (EdDSA JWT via auth JWKS, `scope=full`), `typ=CUSTOMER`; access = owner **or**
active member (members: read + orders only). Others' ids → **404**. POSTs that create accept
`Idempotency-Key` (Redis 24 h, replay returns stored response). Mutations on a draft/farm require
`If-Match: <version>` → `412 FARM_VERSION_CONFLICT`.

| #   | Method · Path                                                                                                            | Rate limit      | Request                                                                                                                        | Response (`data`)                                                                                                                                                                      | Budget             |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| C1  | GET `/farms/categories`                                                                                                  | —               | —                                                                                                                              | `[{ category, title, subtitle, requiredDocs[], productionTypes[], capacityFields[{productionType, metric, period, unit}], typeCodes }]` · `Cache-Control: public, max-age=3600` + ETag | 50 ms              |
| C2  | POST `/farms`                                                                                                            | 10/day/user     | `{ category }`                                                                                                                 | `FarmDraft` (status DRAFT, step 1, `farmCodePreview`) · 201 · max 3 open drafts → 409 `DRAFT_LIMIT_REACHED`                                                                            | 200                |
| C3  | POST `/farms/quick`                                                                                                      | 5/day/user      | `{ name, addressLine, village, pinCode, latitude?, longitude?, accuracyM?, consents? }`                                        | `FarmDetail` ACTIVE + `farmCode` (BACKYARD, no KYC) · 201                                                                                                                              | 200                |
| C4  | PATCH `/farms/{id}/details`                                                                                              | —               | `{ name, ownerName, productionTypes[] (ordered, 1–4, category-valid), capacities[{ productionType, metric, value, period }] }` | `FarmDraft` (step ≥ 2)                                                                                                                                                                 | 200                |
| C5  | GET `/farms/geo/pincodes/{pin}`                                                                                          | 60/min/user     | —                                                                                                                              | `{ pinCode, serviceable, territory{code,name}, districtName, mandalName, villages[], primaryNode{id,name}, backupNode{id,name}, deliveryPromise }` · 404 unknown                       | **50** (LRU+Redis) |
| C6  | PUT `/farms/{id}/location`                                                                                               | —               | `{ latitude, longitude, accuracyM ≤ 100, capturedAt, village, pinCode, addressLine? }`                                         | `FarmDraft` with resolved territory/node · 422 `PIN_NOT_SERVICEABLE` / `LOCATION_INACCURATE`                                                                                           | 200                |
| C7  | POST `/farms/{id}/kyc/aadhaar/otp`                                                                                       | 3/h/owner       | `{ aadhaarNumber (12 digits, Verhoeff), consent: true }`                                                                       | `{ txnRef, expiresIn, maskedAadhaar }` (txn in Redis 10 min)                                                                                                                           | ext                |
| C8  | POST `/farms/{id}/kyc/aadhaar/verify`                                                                                    | 5/txn           | `{ txnRef, otp }`                                                                                                              | `{ verified, aadhaarLast4, nameMatch }` · 422 `AADHAAR_OTP_INVALID`                                                                                                                    | ext                |
| C9  | PUT `/farms/{id}/kyc/pan`                                                                                                | 5/h/owner       | `{ pan (^[A-Z]{5}[0-9]{4}[A-Z]$), documentId? }`                                                                               | `{ panMasked, nameMatch, kycStatus }`                                                                                                                                                  | 200 / ext          |
| C10 | POST `/farms/{id}/kyc/documents`                                                                                         | 20/h/owner      | `{ docType, storageKey, sha256, contentType, sizeBytes }` (upload first to media-service, private)                             | `KycDocument` · supersedes previous same-type doc                                                                                                                                      | 200                |
| C11 | POST `/farms/{id}/kyc/gstin/verify`                                                                                      | 10/h/user       | `{ gstin (format + checksum) }`                                                                                                | `{ verificationId, tradeName, legalName, portalStatus, checkedAt, nameMatchesFarm, options:[GST_TRADE_NAME, FARM_NAME] }` · 422 `GSTIN_INACTIVE`                                       | ext (24 h cache)   |
| C12 | PUT `/farms/{id}/billing`                                                                                                | —               | `{ gstin, verificationId, invoiceNameSource }` (FARM_NAME on mismatch → flagged "For Review")                                  | `FarmDraft`                                                                                                                                                                            | 200                |
| C13 | POST `/farms/{id}/kyc/defer`                                                                                             | —               | —                                                                                                                              | sets `kycDeferredAt` (business categories)                                                                                                                                             | 200                |
| C14 | PATCH `/farms/{id}/owner`                                                                                                | —               | `{ ageBand?: AgeBand \| null, consents?: { personalizedOffers: bool } }`                                                       | `OwnerSummary` (consent row appended)                                                                                                                                                  | 200                |
| C15 | POST `/farms/{id}/submit`                                                                                                | 5/day/user      | `{ acknowledgePermanentId: true }`                                                                                             | `{ status: ACTIVE, farmCode }` \| `{ status: UNDER_REVIEW, caseId }` · 422 `SUBMIT_INCOMPLETE` `details.missing[]`                                                                     | 200                |
| C16 | GET `/farms/{id}/verification`                                                                                           | —               | —                                                                                                                              | `{ status, statusLabel, timeline[{ step, label, at, actorFirstName? }], question?{ caseId, message, matchedFarm? (same owner only) }, issues[{ docType, code, title, message }] }`     | 50                 |
| C17 | POST `/farms/{id}/verification/claim`                                                                                    | —               | `{ claim: SEPARATE_UNIT \| SAME_FARM }`                                                                                        | updated verification                                                                                                                                                                   | 200                |
| C18 | POST `/farms/{id}/resubmit`                                                                                              | 5/day           | `{}` (after C10 fixes)                                                                                                         | as C15                                                                                                                                                                                 | 200                |
| C19 | GET `/farms`                                                                                                             | —               | `?status&cursor&limit≤50`                                                                                                      | `FarmSummary[]` (owned + member)                                                                                                                                                       | **50**             |
| C20 | GET `/farms/{id}`                                                                                                        | —               | —                                                                                                                              | `FarmDetail` (owner masked, capacities, location, kyc summary, step) · `ETag`                                                                                                          | **50**             |
| C21 | PATCH `/farms/{id}`                                                                                                      | —               | `{ addressLine?, capacities? }` (ACTIVE only; name locked)                                                                     | `FarmDetail`; `farm.updated.v1`                                                                                                                                                        | 200                |
| C22 | GET `/farms/{id}/pass`                                                                                                   | —               | —                                                                                                                              | `{ farmCode, name, ownerName, shedsLabel, locationLabel, productionSummary, totalBirdCapacity, memberSince, qr:{ payload, signature }, shareText }`                                    | **50**             |
| C23 | GET/POST `/farms/{id}/members` · PATCH/DELETE `/farms/{id}/members/{memberId}`                                           | 10/day          | `{ phone, fullName, orderLimit }` · `{ orderLimit }`                                                                           | `FarmMember` — owner only; creates SUPERVISOR user via auth `/internal/users`                                                                                                          | 200                |
| C24 | GET `/farms/verify/{farmCode}?sig=`                                                                                      | PUB · 30/min/IP | —                                                                                                                              | `{ farmCode, name, status, territory }` (QR scan by driver/field; HMAC-signed)                                                                                                         | 50                 |
| C25 | Phase 6: `/farms/{id}/sheds` · `/flocks` · `/health-records` · `/photos` · `/profile/versions` · POST `/farms/{id}/sync` | —               | CRUD; `sync` = batch ≤ 100 ops with `clientMutationId`                                                                         | idempotent per op                                                                                                                                                                      | 200                |

---

## 6. Admin APIs — `/v1/admin/farms` (gateway → service `/admin/farms`)

All: `requireAuth` + `typ=INTERNAL` + `scope=full` (MFA) + `requirePermission(key)`; writes need
`reason` (10–500 chars), write `farm_audit_log` in the same transaction, and accept `If-Match`.
Responses mask PAN/Aadhaar; GLOBAL scope only until scoped checks land (D-18), then REGION =
territory filter injected in the repository.

| #   | Method · Path                                                                       | Permission                                      | Request → Response                                                                                                                                                                                  | Budget     |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A1  | GET `/admin/farms`                                                                  | customers.view                                  | `?q (farmCode/name/phone/gstin)&status&category&productionType&territoryCode&pinCode&kycStatus&channel&createdFrom&createdTo&sort(createdAt\|submittedAt)&cursor&limit≤100` → `AdminFarmListItem[]` | 200        |
| A2  | GET `/admin/farms/stats`                                                            | customers.view                                  | → counts by status × category × territory (cached 60 s)                                                                                                                                             | 50         |
| A3  | GET `/admin/farms/{id}`                                                             | customers.view                                  | → `AdminFarmDetail` (owner, KYC masked, capacities, location, members, open cases, docs meta)                                                                                                       | 50 (cache) |
| A4  | GET `/admin/farms/{id}/history`                                                     | customers.view                                  | → status events + audit rows (cursor)                                                                                                                                                               | 200        |
| A5  | POST `/admin/farms`                                                                 | customers.create                                | assisted registration: `{ ownerPhone, consentOtpToken, category, …details, location }` → `FarmDraft` (`channel=FIELD_ASSISTED`, `createdByUserId`)                                                  | 200        |
| A6  | PATCH `/admin/farms/{id}`                                                           | customers.update                                | `{ name?, ownerName?, capacities?, location?, gstin?, reason }` → `AdminFarmDetail` (farmCode never editable)                                                                                       | 200        |
| A7  | GET `/admin/farms/review-queue`                                                     | customers.verify                                | `?type=DUPLICATE\|KYC&assignee=me\|unassigned&overdue&cursor` → items sorted by `slaDueAt`                                                                                                          | 200        |
| A8  | GET `/admin/farms/review-cases/{caseId}`                                            | customers.verify                                | → side-by-side `{ farm, matchedFarm, signals, distanceM, nameSimilarity, ownerClaim }`                                                                                                              | 50         |
| A9  | POST `/admin/farms/review-cases/{caseId}/assign`                                    | customers.verify                                | `{ assigneeUserId }`                                                                                                                                                                                | 200        |
| A10 | POST `/admin/farms/review-cases/{caseId}/decision`                                  | customers.verify (MERGE also `customers.merge`) | `{ decision: APPROVE_SEPARATE\|MERGE\|REQUEST_CHANGES\|REJECT, issues?[], reason }` · SoD → 403 `SOD_VIOLATION`                                                                                     | 200        |
| A11 | GET `/admin/farms/{id}/kyc/documents`                                               | customers.verify                                | → document metadata list                                                                                                                                                                            | 50         |
| A12 | GET `/admin/farms/{id}/kyc/documents/{docId}/url`                                   | customers.verify                                | → `{ url, expiresIn: 60 }` signed private GET; audited `pii.document_view`                                                                                                                          | 200        |
| A13 | POST `/admin/farms/{id}/kyc/documents/{docId}/decision`                             | customers.verify                                | `{ decision: ACCEPT\|REJECT, rejectionCode?, note?, reason }` → recomputes `kycStatus`                                                                                                              | 200        |
| A14 | POST `/admin/farms/{id}/request-changes`                                            | customers.verify                                | `{ issues[{ docType, code, message }], reason }` → NEEDS_ATTENTION                                                                                                                                  | 200        |
| A15 | POST `/admin/farms/{id}/suspend` · `/reactivate` · `/close`                         | customers.suspend                               | `{ reasonCode, reason }`                                                                                                                                                                            | 200        |
| A16 | POST `/admin/farms/exports` · GET `/admin/farms/exports/{jobId}`                    | customers.export                                | filters → BullMQ job → CSV (masked) in private storage → signed URL 5 min; audited                                                                                                                  | 200        |
| A17 | GET/POST/PATCH `/admin/farms/geo/territories`                                       | territories.manage                              | territory master                                                                                                                                                                                    | 200        |
| A18 | GET/PUT `/admin/farms/geo/pincodes/{pin}` · POST `/admin/farms/geo/pincodes/import` | territories.manage                              | pin → territory/mandal/nodes/promise; CSV bulk (≤ 20k rows, validation report); busts pin cache                                                                                                     | 200        |

**New permission keys** (add to `permissions.catalog.ts`, module `customers` / new `territories`):
`customers.merge` (sensitive, G) · `territories.manage` (sensitive, G).

---

## 7. Internal APIs (service-to-service, `internalAuth` token, not exposed by gateway)

| Method · Path                              | Consumer                            | Response                                                                                                                                                                                       | Budget              |
| ------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| GET `/internal/farms/{id}`                 | order, clinical, logistics, pricing | `{ id, farmCode, ownerId, ownerUserId, status, kycStatus, category, productionTypes, totalBirdCapacity, capacities, pinCode, territoryCode, primaryNodeId, backupNodeId, gstin, invoiceName }` | **≤ 10 ms** (cache) |
| POST `/internal/farms/batch`               | same                                | `{ ids[] ≤ 100 }` → map                                                                                                                                                                        | 50                  |
| GET `/internal/farms/by-code/{farmCode}`   | COA/trace, driver POD               | as above                                                                                                                                                                                       | 10                  |
| GET `/internal/farms/{id}/access/{userId}` | order (checkout, delegate ceiling)  | `{ allowed, role, orderLimit }`                                                                                                                                                                | 10                  |

---

## 8. Events (`packages/infra/src/events/contracts/farm.events.ts`, outbox in same tx)

| Type                                              | When                             | `data` (no PII beyond need)                                                                                  | Consumers                                                             |
| ------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `farm.submitted.v1`                               | submit/resubmit                  | farmId, ownerId, category, channel                                                                           | analytics                                                             |
| `farm.activated.v1`                               | Farm ID issued                   | farmId, farmCode, ownerId, ownerUserId, category, productionTypes, territoryCode, pinCode, totalBirdCapacity | notification (pass via SMS/WhatsApp/email), loyalty, order read model |
| `farm.review_required.v1`                         | case opened                      | farmId, caseId, signals, slaDueAt                                                                            | notification (ops), support                                           |
| `farm.needs_attention.v1`                         | changes requested                | farmId, ownerUserId, issues[{docType, code}]                                                                 | notification                                                          |
| `farm.status_changed.v1`                          | any transition                   | farmId, from, to, reasonCode, actorType                                                                      | order, ads targeting                                                  |
| `farm.updated.v1`                                 | capacity/location/billing change | farmId, changedFields[]                                                                                      | pricing (tonnage tiers), logistics                                    |
| `farm.merged.v1`                                  | merge                            | farmId, intoFarmId                                                                                           | all read models                                                       |
| `farm.owner_kyc_changed.v1`                       | kycStatus change                 | ownerId, kycStatus                                                                                           | order, clinical, payment                                              |
| `farm.member_added.v1` / `farm.member_revoked.v1` | delegates                        | farmId, userId, role, orderLimit                                                                             | order                                                                 |

**Consumes:** `user.deleted.v1` → anonymise owner (`fullName='Deleted user'`, PAN/Aadhaar fields
nulled, consents kept), farms → CLOSED; `user.status_changed.v1` → member status sync.

---

## 9. Architecture & code layout

```
services/farm-service/                      port 3003 · @farmx/farm-service
  src/
    config/index.ts        FARM_SERVICE_PORT, DATABASE_URL, REDIS_CACHE_URL, REDIS_QUEUE_URL,
                           AUTH_JWKS_URL, AUTH_SERVICE_URL, MEDIA_SERVICE_URL, INTERNAL_SERVICE_TOKEN,
                           FARM_PII_ENC_KEYS (kid:base64,…), FARM_PII_HMAC_KEY, FARM_PASS_SIGNING_KEY,
                           AADHAAR_PROVIDER(fake|<vendor>), GST_PROVIDER(fake|<vendor>) + URLs/keys,
                           DEDUPE_RADIUS_M=150, REVIEW_SLA_HOURS=4, DRAFT_TTL_DAYS=30
    adapters/              aadhaar.ts · gst.ts (port + fake + real, timeout 3 s, circuit breaker)
                           auth-client.ts (internal HTTP) · media-client.ts (signed URLs) · pii-crypto.ts
    features/
      farms/     routes · controller · service · repository · validation · types · docs · module · index
                 + farm.state.ts · farm-code.ts · admin.routes.ts (same feature, admin surface)
      geo/       pincode lookup + admin masters (LRU + Redis)
      kyc/       aadhaar/pan/gstin/documents + admin decisions
      review/    dedupe engine + DuplicateCase + queue/decisions
      members/   delegates
      profile/   (Phase 6) sheds/flocks/health/photos/versions/sync
      audit/     farm_audit_log writer (record(entry, tx)) + history reads
      internal/  /internal/* read APIs
    jobs/        BullMQ: draft-expiry, review-sla-escalation, export
    middleware/  require-auth.ts · require-permission.ts (shared, see P0)
    routes/index.ts · container.ts · app.ts · server.ts
  tests/unit · tests/integration
```

- **Feature calls:** `farms.service.submit()` → `review` (dedupe via `review/index.ts`), `audit`,
  outbox — one `runInTransaction`; cache invalidation + job enqueue **after commit**.
- **Gateway:** add `FARM_SERVICE_URL` + routes `{'/v1/farms' → '/farms'}`, `{'/v1/admin/farms' → '/admin/farms'}`,
  `{'/v1/farm-service' → ''}` (docs/health). Root `dev` script gets the service.
- **Caching (redis-cache, keys via `@farmx/infra` keyspace `farm:v1:*`):**

  | Key                                     | Value                | TTL    | Invalidate                       |
  | --------------------------------------- | -------------------- | ------ | -------------------------------- |
  | `farm:{id}`                             | FarmDetail JSON      | 10 min | after any write to the farm      |
  | `owner-farms:{userId}`                  | FarmSummary[]        | 5 min  | farm create/status/member change |
  | `code:{farmCode}`                       | farmId               | 7 d    | never (immutable)                |
  | `pin:{pin}` (+ in-process LRU 5k/5 min) | PinCode info         | 24 h   | pincode admin write              |
  | `gstin:{gstin}`                         | GST snapshot         | 24 h   | —                                |
  | `aadhaar-txn:{ownerId}`                 | txnRef + attempts    | 10 min | verify/expiry                    |
  | `idem:{userId}:{key}`                   | response hash + body | 24 h   | —                                |

  Stampede protection with the existing `redis/lock.ts` (single-flight). Redis down → reads fall
  through to DB (fail open for reads), Aadhaar OTP fails closed (503).

- **Query rules:** `select` only needed columns; detail = 1 query (farm + capacities + owner via
  same-feature relation); lists use keyset `WHERE id < cursor ORDER BY id DESC LIMIT n+1`; no
  `count(*)` on lists (stats endpoint is cached); `pg` pool from `getDatabase()`.
- **Response serialization:** Joi → JSON Schema (`joi-to-swagger`) set as Fastify `response` schema
  so fast-json-stringify serialises and strips unknown fields (prevents accidental PII leaks).
- **Swagger:** each feature has `<feature>.docs.ts` with `routeDocs()`; tags `Farms · Registration`,
  `Farms · KYC`, `Farms · Geo`, `Farms · Members`, `Farms · Profile`, `Admin · Farms`,
  `Admin · Farm Review`, `Admin · Geo`; components `FarmDraft`, `FarmDetail`, `FarmSummary`,
  `FarmPass`, `PinCodeInfo`, `GstVerification`, `VerificationStatus`, `KycDocument`,
  `DuplicateCase`, `AdminFarmListItem`, `AdminFarmDetail`, `FarmMember`; headers `Idempotency-Key`,
  `If-Match`, `ETag`; every error code below documented per route. Served at
  `/v1/farm-service/api-docs` (+ `/api-docs.json`); `/internal/*` hidden.
- **Error codes** (`AppError` subclasses, envelope per CLAUDE.md):
  `FARM_NOT_FOUND` 404 · `FARM_STATE_INVALID` 409 · `DRAFT_LIMIT_REACHED` 409 · `FARM_VERSION_CONFLICT` 412 ·
  `SUBMIT_INCOMPLETE` 422 · `PIN_NOT_SERVICEABLE` 422 · `LOCATION_INACCURATE` 422 ·
  `AADHAAR_OTP_INVALID` 422 · `AADHAAR_OTP_EXPIRED` 422 · `GSTIN_INVALID` 422 · `GSTIN_INACTIVE` 422 ·
  `PAN_INVALID` 422 · `SOD_VIOLATION` 403 · `KYC_PROVIDER_UNAVAILABLE` 503 · `RATE_LIMITED` 429.

---

## 10. Security checklist

- [ ] JWT verified in-service (EdDSA via JWKS, cached keys) + `revoked:sid` check; `typ` enforced per surface.
- [ ] Ownership predicate in **every** repository query (`ownerUserId = $me OR member`); 404 on miss (no IDOR, no enumeration).
- [ ] Admin: MFA scope, permission key, reason, audit in-tx, SoD, If-Match.
- [ ] PAN: AES-256-GCM with key id (rotation), HMAC lookup; masked in every response/log/export.
- [ ] Aadhaar never persisted; Pino redact paths `aadhaarNumber`, `pan`, `otp`, `*.panCipher`.
- [ ] KYC files in a **private** bucket only; 60 s signed GET; view audited.
- [ ] Joi strict validation (unknown keys → 422), India lat/lng bbox, PAN/GSTIN/Verhoeff checksums, body limit 64 KB.
- [ ] Rate limits per §5; Idempotency-Key on creating POSTs; webhook-style replay safe.
- [ ] Duplicate-review messages never reveal another owner's data.
- [ ] DPDP: consent ledger, purpose limitation (personalised tips flag), `user.deleted.v1` anonymisation, draft purge job.
- [ ] Append-only + immutability triggers; app role lacks UPDATE/DELETE on audit tables.
- [ ] Response schemas strip undeclared fields.

---

## 11. Phases (each ends with typecheck + lint + tests green, PROGRESS.md updated)

| Phase                              | Deliverable                                                                                                                                                                                                                                                                                                                                          | Exit criteria                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **P0 · Prerequisites**             | (a) shared `requirePermission` for non-auth services: read auth's `perms:{userId}` cache, fallback `GET /internal/access/{userId}/permissions` on auth-service; (b) media-service `visibility=private` upload + signed GET; (c) auth `POST /internal/users` (delegate/assisted owner) + consent-OTP for field registration; (d) outbox writer helper | unit + integration tests; decisions D-22…D-26 recorded                                                                           |
| **P1 · Scaffold + schema**         | copy `_template` → `farm-service`; config; Prisma files §3.1–3.5, 3.7 + raw SQL §3.8; seed territories (WG, EG, KR, …) + AP pin codes → nodes; gateway routes; Swagger shell; health                                                                                                                                                                 | `pnpm db:migrate` clean; triggers tested (immutable code, append-only)                                                           |
| **P2 · Registration journey**      | C1–C6, C14–C15, C19–C22, C3 quick; state machine; Farm ID allocator; dedupe engine + case creation; caches; status events; audit                                                                                                                                                                                                                     | integration tests: full 5-step happy path, concurrent submit (no duplicate serials, 50 parallel), dedupe each signal, IDOR tests |
| **P3 · KYC + verification**        | C7–C13, C16–C18; Aadhaar/GST adapters (fake + real behind config); doc upload flow; kycStatus calc                                                                                                                                                                                                                                                   | provider timeout/breaker tests; no Aadhaar in logs (log-capture test)                                                            |
| **P4 · Admin**                     | A1–A18; review queue + SLA escalation job; SoD; exports job; stats; new permission keys                                                                                                                                                                                                                                                              | permission-matrix tests (every route 401/403/200); audit row per write                                                           |
| **P5 · Members, internal, events** | C23–C24, §7, §8 contracts + outbox rows; `user.deleted.v1` consumer                                                                                                                                                                                                                                                                                  | contract tests; delegate ceiling read by `/internal/.../access`                                                                  |
| **P6 · Farm profile (S)**          | C25: sheds, flocks, health records, photos, versions, offline `sync`                                                                                                                                                                                                                                                                                 | idempotent replay of a 100-op batch                                                                                              |
| **P7 · Hardening**                 | k6 load test (p95 targets §0 at 200 rps reads / 50 rps writes on dev box), EXPLAIN on every list/dedupe query, security review (`/security-review`), docs: API_PLAN §2, event-contracts, decisions, PROGRESS                                                                                                                                         | SLOs met; no seq scans on hot paths                                                                                              |

---

## 12. Proposed decisions (add to `docs/decisions.md` when approved)

- **D-22** farm-service owns `farm_audit_log` (same columns as `admin_audit_log`), written in-tx; a unified admin audit view comes later via read model.
- **D-23** Non-auth services check permissions through auth's Redis perms cache with an internal-HTTP fallback (still default-deny).
- **D-24** PAN is app-encrypted (AES-256-GCM, key id) + HMAC for lookup; Aadhaar is never stored (last 4 + provider ref only).
- **D-25** Farm ID format `FX-{territory}-{type}-{serial}`, per territory/type sequence, issued only on activation, immutable by trigger.
- **D-26** Territories and pin→node mapping live in farm-service (`geo`) until logistics-service exists, then become an event-fed read model.

## 13. Open questions

1. Does BACKYARD get a Farm ID (`FX-WG-R-…`, assumed) or only a customer profile?
2. KYC deferral: which features are gated, and is there a deadline before suspension?
3. Same-owner "separate unit" claims: auto-approve or always human review (assumed human, SLA 4 h)?
4. Aadhaar OTP and GST verification providers (adapters stubbed until chosen).
5. Hatchery screen "Sai Ganesh Feeds (Mill) · 8 tonnes/month": the hatchery's own feed consumption (assumed, stored as `FEED_TONNES / PER_MONTH`) or a linked feed-mill unit?
6. Dedupe radius 150 m and name-similarity 0.6 — confirm with ops.
