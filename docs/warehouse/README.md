# Warehouse portal backend: warehouse-service (:3014, D-56)

For the frontend team building the warehouse portal (Login + Multi-Warehouse). Every path below is
on the gateway (`/v1/...`); all responses use the standard envelope. Swagger: `/api-docs`, tags
**Admin Warehouses**, **Admin Warehouse Service Areas**, **Admin Warehouse Storage**, **Admin
Warehouse Dock & Yard**, **Admin Warehouse Calendar**, **Admin Warehouse Storage Rules**, **Admin
Warehouse Team**, **Warehouse Portal**.

## Status

| Phase | Scope                                                                                                    | State |
| ----- | -------------------------------------------------------------------------------------------------------- | ----- |
| P0    | Warehouse-scoped permissions, invite-only staff, event contracts                                         | ✅    |
| P1    | warehouse-service, warehouse master + wizard step 1 + status, service areas, portal shell                | ✅    |
| P2    | Storage (zones/racks/bins), dock & yard, calendar & shifts, storage rules, team                          | ✅    |
| P3    | Stock / capacity numbers, W2.03 overview, active orders                                                  | ✅    |
| D-57a | Stock W4.00–W4.11, interim inbound, restock / transfers, cutover (Phases 1–2)                            | ✅    |
| D-57b | Fulfilment W3.01–W3.16, W3.18 prepaid, W3.19 views, dispatch, delivery, routing, ATP, split (Phases 3–5) | ✅    |

`GET /v1/admin/wms/me` → `modules` tells the UI which screens have a backend today.

## Login (auth-service)

| Screen element                                    | API                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Sign in                                           | `POST /v1/auth/auth/admin/login` → tokens, `mfa_required`, or `mfa_enrollment_required`          |
| Wrong email / password                            | 401 "Invalid credentials" (show "The email or password is incorrect.")                           |
| Locked / too many attempts                        | 403 / 429 (`retry-after`)                                                                        |
| MFA code                                          | `POST /v1/auth/auth/mfa/verify`                                                                  |
| Forgot / reset password                           | `POST /v1/auth/auth/password/forgot`, `/reset`                                                   |
| **Accept invitation** (replaces "Create account") | `POST /v1/auth/auth/invitations/accept {email, code, newPassword}` → 204, then sign in           |
| Password hint                                     | 12+ characters, 3 of: lower, upper, digit, symbol (not "Minimum 8")                              |
| After login                                       | `GET /v1/admin/wms/me` (switcher, sidebar, "No warehouse access yet" when `warehouses` is empty) |
| Header search                                     | `GET /v1/admin/wms/search?q=` (warehouses; a 6-digit PIN also shows who serves it)               |
| Notification bell                                 | notification-service `/v1/notifications`                                                         |

Staff accounts are **invite-only**: a manager adds them from Warehouse Team; they get a
6-digit code by email (48 h).

## W2.01 All Warehouses

| Element                                       | API                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| KPI cards                                     | `GET /v1/admin/warehouses/summary` (stock units, used kg, capacity %, `asOf`)       |
| Table, search, type/status/state/city filters | `GET /v1/admin/warehouses?q&type&status&stateCode&city&cursor&limit` → `meta.total` |
| Export                                        | `GET /v1/admin/warehouses/export.csv` (same filters)                                |
| View / Configure                              | `GET /v1/admin/warehouses/:id`                                                      |

## W2.02 Add Warehouse wizard

| Step / element      | API                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Form dropdowns      | `GET /v1/admin/warehouses/lookups` (states, temperature classes, types, statuses, priorities)  |
| Code check          | `GET /v1/admin/warehouses/code-availability?code=`                                             |
| Manager picker      | auth `GET /v1/auth/admin/users?userType=INTERNAL&status=ACTIVE&q=`                             |
| 1 Basic details     | `POST /v1/admin/warehouses` (SETUP draft); edits `PATCH /:id {expectedVersion, …}`             |
| 2 Service area      | see W2.04                                                                                      |
| 3 Storage, 4 Team   | see W2.05 and Warehouse Team                                                                   |
| 5 Review / Activate | `GET /:id` (`setup.steps`), `POST /:id/activate {expectedVersion}` (422 lists what is missing) |
| Discard draft       | `DELETE /:id?expectedVersion=`                                                                 |

Capacity: `{value, unit: KG|TONNES}`, stored and returned as `capacityKg`. Temperature
capability is multi-select. Phone: 10 digits (stored +91…).

## W2.03 Warehouse details (header)

`GET /v1/admin/warehouses/:id`: name, status, code, address, manager, capacity, temperature
classes, `reviewFields` (imported warehouses: show "Imported data to confirm"; confirm with
`PATCH {confirm: [...]}` or by editing). Status actions: `POST /:id/limit | deactivate | reactivate`
(reason required for limit / deactivate). Deactivate answers 409 `HAS_OPEN_ORDERS` while orders are
still to be fulfilled there. `stock` + `capacityUsedPct` = latest snapshot.

| Element                       | API                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Overview cards + status board | `GET /v1/admin/warehouses/:id/overview`                                                              |
| Stock tab + category donut    | `GET /v1/admin/warehouses/:id/stock-by-category`                                                     |
| Active Orders tab             | `GET /v1/admin/warehouses/:id/orders?status=OPEN\|NEW\|ALLOCATED\|DELIVERED\|CANCELLED&cursor&limit` |
| Transfers / Performance tabs  | not built (W12 / W3, W9, W11): overview returns null with `modules` flags                            |

- Stock figures refresh every minute (`asOf`). `stale: true` = inventory has not answered for 3
  refreshes; keep showing the numbers with a "last updated" note.
- Capacity is weight-based. When `weightKnownPct` < 100, show "based on X% of stock with known
  weight"; `unweighedSkus` = SKUs the product team must give a pack weight.
- Status board: Receiving & Dispatch (OPERATIONAL / LIMITED / CLOSED_TODAY / INACTIVE), Cold
  Storage (OPERATIONAL / MAINTENANCE / NOT_CONFIGURED), System Sync (CONNECTED / DELAYED / NO_DATA).

## W2.04 Service Area

| Element                                      | API                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| KPIs + table                                 | `GET /v1/admin/warehouses/:id/service-areas` (`coverageVersion` = expectedVersion for writes)                  |
| District dropdown                            | `GET /v1/admin/warehouses/lookups/districts?stateCode=` (suggestions; new names allowed)                       |
| Add area                                     | `POST /:id/service-areas {expectedVersion, stateCode, district, priority, pins: ['411001-411045', '411050']}`  |
| Edit (priority, district, add / remove PINs) | `PATCH /:id/service-areas/:areaId`                                                                             |
| Delete one / bulk                            | `DELETE /:id/service-areas/:areaId?expectedVersion=` · `DELETE /:id/service-areas?ids=a,b&expectedVersion=`    |
| Edit form PINs                               | `GET /:id/service-areas/:areaId` (`pins`, `ranges`)                                                            |
| "Move to district" (imported PINs)           | `POST /:id/service-areas/:areaId/reassign {expectedVersion, all: true \| pins, stateCode, district, priority}` |
| Routing preview                              | `GET /v1/admin/warehouses/coverage/:pinCode`                                                                   |

Map view: colour districts by `priority`; district boundaries are a frontend asset.

## W2.05 Storage Setup (wizard step 3)

All paths below are under `/v1/admin/warehouses/:id`. Writes need `warehouse.configure`; edits of
zones and racks send `expectedVersion`.

| Element                         | API                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Layout grid + legend            | `GET /storage/layout` (zones → racks → bins: codes, temperature class, status)                          |
| Zones table / add / edit / del  | `GET /zones` · `POST /zones` · `PATCH /zones/:zoneId` · `DELETE /zones/:zoneId`                         |
| Racks table (zone filter)       | `GET /racks?zoneId=` (available weight, volume and %)                                                   |
| Add rack (+ auto bins)          | `POST /zones/:zoneId/racks {maxWeightKg, volumeM3, generateBins?: {count, maxWeightKg, volumeM3}}`      |
| Edit / delete rack              | `PATCH /racks/:rackId` · `DELETE /racks/:rackId`                                                        |
| Bins table (rack / zone filter) | `GET /bins?rackId&zoneId&cursor&limit`                                                                  |
| Add bins                        | `POST /racks/:rackId/bins {count, maxWeightKg, volumeM3}` or `{bins: [{code?, maxWeightKg, volumeM3}]}` |
| Edit / delete bin               | `PATCH /bins/:binId` · `DELETE /bins/:binId`                                                            |

- Codes are generated when left out: zone `A` → racks `A-01…` → bins `A-01-01…` (≤ 200 bins per call).
- The bins of a rack never exceed its weight or volume: 409 `RACK_CAPACITY_EXCEEDED` with what is left.
- A zone with racks, or a rack with bins: 409 `NOT_EMPTY`. Bin `used*` stays 0 until put-away (W8).

## Warehouse Team (wizard step 4, W2.06)

| Element                | API                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Table                  | `GET /:id/team` (role, phone, work areas, document status, status, account INVITED / ACTIVE)                      |
| + Add Employee         | `POST /:id/team {fullName, email, phone?, roleId, workAreas[], shiftId?}` → invitation email (48 h)               |
| Edit                   | `PATCH /:id/team/:userId {phone?, workAreas?, shiftId?, roleId?}`                                                 |
| Remove                 | `DELETE /:id/team/:userId {reason}` (roles here revoked; the row stays INACTIVE)                                  |
| Resend invite          | `POST /:id/team/:userId/resend-invite`                                                                            |
| Upload a document      | media-service `POST /v1/upload?purpose=staff_document`, then `PUT /:id/team/:userId/documents {docType, receipt}` |
| View documents         | `GET /:id/team/:userId/documents` (5-minute signed URLs)                                                          |
| Role permissions panel | `GET /v1/admin/warehouses/team/roles` → **read-only** (`editable: false`)                                         |

- Team writes need `warehouse.team_manage` at that warehouse. The role can grant nothing the
  manager lacks there (403 `PRIVILEGE_ESCALATION`).
- Roles are global templates. Edit them only in the central console: auth
  `GET /v1/auth/admin/roles/:id/usage` ("used by N staff in M warehouses"), then
  `PUT /admin/roles/:id/permissions`.
- Document status is COMPLETE when ID proof, address proof and photo are uploaded (JPEG, PNG, WebP
  or PDF, ≤ 10 MB, virus-scanned).

## W2.07 Dock & Yard

| Element                  | API                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| KPIs                     | `GET /:id/dock-yard` (doors total / active / busy / inactive, staging, yard, `unloadingCapacity[]`)                                            |
| Dock doors tab           | `GET /:id/dock-doors` (`displayStatus` AVAILABLE / BUSY / INACTIVE, `currentUse`)                                                              |
| Add / edit / delete door | `POST /:id/dock-doors` · `PATCH /:id/dock-doors/:doorId {expectedVersion, …}` · `DELETE …`                                                     |
| Mark busy                | `POST /:id/dock-doors/:doorId/bookings {refNo, direction, loadQty, plannedStart, plannedEnd}`, then `POST /:id/dock-bookings/:bookingId/start` |
| Mark free / cancel       | `POST /:id/dock-bookings/:bookingId/complete` · `…/cancel`                                                                                     |
| Unloading capacity tab   | `GET /:id/dock-bookings?date=YYYY-MM-DD` + the `dock-yard` summary                                                                             |
| Staging areas tab        | `GET` / `POST /:id/staging-areas` · `PATCH` / `DELETE /:id/staging-areas/:stagingId`                                                           |
| Yard slots tab           | `GET` / `POST /:id/yard-slots` · `PATCH` / `DELETE /:id/yard-slots/:slotId`                                                                    |
| Yard in / out            | `POST /:id/yard-slots/:slotId/occupy {vehicleNo}` · `POST /:id/yard-slots/:slotId/release`                                                     |

- `unloadingCapacity` has one line per unit (TONNES, PALLETS). Show them separately; never add
  them. A booking's `loadQty` is in its door's unit.
- Overlapping open bookings on one door: 409 `DOCK_BUSY` (the database enforces it too).
- Changing a door's unit while it has open bookings: 409 `DOOR_HAS_BOOKINGS`.
- Bookings and yard moves need `warehouse.operate`; door, staging and slot setup needs
  `warehouse.configure`.

## W2.09 Operating Calendar & Shifts

| Element                    | API                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| KPIs + weekly grid + lists | `GET /:id/calendar` (`today`, `operatingHours[7]`, `cutoffs`, `shifts`, `holidays`, `upcomingHolidays`) |
| Edit working hours         | `PUT /:id/operating-hours {days: [{isoDay, isOpen, opensAt, closesAt}]}` (all 7 days)                   |
| Cut-off box                | `PUT /:id/cutoffs {cutoffs: [{type, cutoffTime}]}`                                                      |
| Shifts                     | `POST /:id/shifts` · `PATCH /:id/shifts/:shiftId {expectedVersion, …}` · `DELETE …`                     |
| Holidays                   | `POST /:id/holidays` · `PATCH /:id/holidays/:holidayId` · `DELETE …`                                    |

Times are `HH:mm` in the warehouse timezone. A shift ends after it starts unless `overnight`, and
its break falls inside it. One holiday per date (409 `DUPLICATE_DATE`); `LIMITED` needs
`limitedFrom` and `limitedTo`.

## W2.08 Storage Compatibility Rules

| Element             | API                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------- |
| KPIs                | `GET /:id/storage-rules/summary`                                                          |
| Tabs (rule type)    | `GET /:id/storage-rules?type=` (SEGREGATION, HAZARD_CLASS, FOOD_GRADE_ZONE, INCOMPATIBLE) |
| Add / edit / delete | `POST /:id/storage-rules` · `PATCH /:ruleId {expectedVersion, …}` · `DELETE /:ruleId`     |
| Category pickers    | catalog `GET /v1/catalog/categories`                                                      |

**Not enforced yet.** Every rule returns `enforcement: "NOT_ENFORCED"` until put-away (W8).

- Show a "Saved, enforced when put-away goes live" badge. Never show "blocked" or "compliant".
- Create and edit return `warnings[]`, e.g. `SAME_ZONE_CONFLICT` (one zone holds both sides, so they
  are 0 m apart). Such rules count as "Items needing review".
- Minimum distance is stored in metres (feet are converted) and measured between zones.

## Permissions (scoped)

`warehouse.view | configure | operate | team_manage` may be granted GLOBALLY or at one warehouse;
`warehouse.create | status_change` are central-only. A warehouse outside the caller's scope
answers **404**; a visible one without the permission answers **403**. Warehouse-scoped staff never
see SETUP drafts.

## Data notes

- The warehouse master moved from inventory-service (same ids). inventory keeps an event-fed copy
  for allocation (`warehouse.upserted.v1`, `warehouse.coverage_replaced.v1`).
- Imported PINs keep their exact old priority in an "Unassigned (imported)" area until an admin
  moves them to a district; imported warehouses list unknown data in `reviewFields`.
- Districts: there is no official district master yet; the lookup suggests names already used.

## D-57 · Order Fulfilment (W3) + In-stock Management (W4)

Generated from the Swagger spec (2026-11-24). Paths are relative: prefix `/v1/admin/wms` (admin panel, GLOBAL)
or `/v1/wms` (warehouse panel, scoped; ✓ in the Panel column). Request / response schemas, permissions and
error codes: gateway `/api-docs`, tags "WMS Admin · <area>" / "WMS Panel · <area>". Every list takes `cursor` or
`page` + `limit`; KPI endpoints take `fresh=true`. Writes on both panels need the permission at that warehouse.

### Stock — W4.00–W4.06, W4.09, W4.10 + interim inbound (receipts, QR, COA, quality, moves, adjustments, thresholds)

| Method | Path                                          | What                                                                      | Panel      |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------- | ---------- |
| GET    | `/stock/adjustments`                          | Adjustments                                                               | ✓          |
| POST   | `/stock/adjustments`                          | Adjust quantities (count correction)                                      | ✓          |
| POST   | `/stock/adjustments/{id}/approve`             | Approve adjustment                                                        | ✓          |
| POST   | `/stock/adjustments/{id}/reject`              | Reject adjustment                                                         | ✓          |
| GET    | `/stock/alerts`                               | W4.06 SKU depletion alerts (all / low / out)                              | ✓          |
| GET    | `/stock/alerts/count`                         | Header badge "Alerts · n"                                                 | ✓          |
| GET    | `/stock/alerts/kpis`                          | W4.06 Depletion KPIs                                                      | ✓          |
| GET    | `/stock/batches/{batchId}`                    | W4.04 Batch header (CN, warehouse, mfg, expiry, bins, ownership, quality) | ✓          |
| PUT    | `/stock/batches/{batchId}/coa`                | Set COA / certificate of a batch                                          | ✓          |
| GET    | `/stock/batches/{batchId}/kpis`               | W4.04 Batch KPIs                                                          | ✓          |
| GET    | `/stock/batches/{batchId}/movements`          | W4.04 Batch movement history                                              | ✓          |
| GET    | `/stock/batches/{batchId}/quality`            | W4.04 COA & quality tab                                                   | ✓          |
| GET    | `/stock/batches/{batchId}/traceability`       | W4.04 Batch overview / traceability                                       | ✓          |
| GET    | `/stock/batches/{batchId}/units`              | W4.04 QR units tab                                                        | ✓          |
| POST   | `/stock/batches/{batchId}/units/generate`     | Generate unit QR for a batch                                              | ✓          |
| GET    | `/stock/category-matrix`                      | Inspect matrix (category × warehouse)                                     | ✓          |
| GET    | `/stock/filter-options`                       | Filter dropdown options (typeahead)                                       | ✓          |
| GET    | `/stock/landing/by-category`                  | W4.00 Stock by category (+ location text, top mover)                      | ✓          |
| GET    | `/stock/landing/kpis`                         | W4.00 In-stock KPIs (total, available, reserved, on hold)                 | ✓          |
| GET    | `/stock/landing/status-mix`                   | W4.00 Stock by status + fulfilment readiness                              | ✓          |
| GET    | `/stock/movements`                            | W4.09 Movement ledger                                                     | ✓          |
| GET    | `/stock/movements/{id}`                       | W4.09 Movement details                                                    | ✓          |
| GET    | `/stock/movements/export.csv`                 | W4.09 Export ledger CSV                                                   | ✓          |
| POST   | `/stock/moves`                                | Move stock to another bin                                                 | ✓          |
| POST   | `/stock/opening/{positionId}/relabel`         | Relabel opening stock into real batches                                   | ✓          |
| GET    | `/stock/overview/kpis`                        | W4.01 KPIs (on hand, available, reserved, QC hold, damaged, quarantined)  | ✓          |
| GET    | `/stock/overview/status-mix`                  | W4.01 Stock status donut                                                  | ✓          |
| GET    | `/stock/overview/warehouses`                  | W4.01 Warehouse stock table (+ share of stock)                            | ✓          |
| GET    | `/stock/ownership`                            | W4.10 Stock by ownership                                                  | ✓          |
| GET    | `/stock/ownership/kpis`                       | W4.10 Ownership KPIs (SOR, FarmX, JIT)                                    | ✓          |
| POST   | `/stock/positions/{id}/owner`                 | Fix the owner of a stock position                                         | ✓          |
| GET    | `/stock/products`                             | Product list (one row per SKU)                                            | ✓          |
| GET    | `/stock/products/{variantId}`                 | W4.03 Product header (image, SKU, brand, category, vendor)                | ✓          |
| GET    | `/stock/products/{variantId}/availability`    | W4.03 Availability tab                                                    | ✓          |
| GET    | `/stock/products/{variantId}/batches`         | W4.03 Batches tab                                                         | ✓          |
| GET    | `/stock/products/{variantId}/kpis`            | W4.03 Product KPIs                                                        | ✓          |
| GET    | `/stock/products/{variantId}/movements`       | W4.03 Movement history                                                    | ✓          |
| GET    | `/stock/products/{variantId}/units`           | Unit QR records of a product                                              | ✓          |
| GET    | `/stock/products/{variantId}/warehouses`      | W4.03 Stock by warehouse                                                  | ✓          |
| GET    | `/stock/products/search`                      | Product list (one row per SKU)                                            | ✓          |
| POST   | `/stock/quality/hold`                         | Quality hold / quarantine                                                 | ✓          |
| POST   | `/stock/quality/release`                      | Quality release (QC hold / quarantine / returned → available)             | ✓          |
| GET    | `/stock/receipts`                             | Receipts (CN list)                                                        | ✓          |
| POST   | `/stock/receipts`                             | Receive stock (CN) / customer return (RT)                                 | ✓          |
| GET    | `/stock/receipts/{id}`                        | Receipt detail                                                            | ✓          |
| GET    | `/stock/records`                              | W4.02 All stock (warehouse × batch × bin × owner)                         | ✓          |
| GET    | `/stock/records/export.csv`                   | W4.02 Export CSV (same filters)                                           | ✓          |
| GET    | `/stock/restock-plan`                         | W4.07 Monthly restock plan                                                | ✓          |
| GET    | `/stock/restock-plan/item`                    | W4.07 Review one plan line                                                | ✓          |
| GET    | `/stock/settings`                             | Stock settings                                                            | admin only |
| PUT    | `/stock/settings`                             | Change stock settings                                                     | admin only |
| POST   | `/stock/status-changes`                       | Change stock status (lifecycle move)                                      | ✓          |
| GET    | `/stock/thresholds/{warehouseId}/{variantId}` | Thresholds of one SKU at a warehouse                                      | ✓          |
| PUT    | `/stock/thresholds/{warehouseId}/{variantId}` | Set thresholds (min, safety, target)                                      | ✓          |
| PUT    | `/stock/thresholds/bulk`                      | Set thresholds for many SKUs                                              | ✓          |
| GET    | `/stock/units/{qrCode}`                       | View one unit (QR)                                                        | ✓          |

### Stock lifecycle — W4.11

| Method | Path                                      | What                                       | Panel      |
| ------ | ----------------------------------------- | ------------------------------------------ | ---------- |
| GET    | `/stock/lifecycle`                        | Lifecycle overview (journey + side states) | ✓          |
| GET    | `/stock/lifecycle/proposals`              | Rule change history (proposals)            | ✓          |
| POST   | `/stock/lifecycle/proposals`              | Propose a transition rule                  | ✓          |
| POST   | `/stock/lifecycle/proposals/{id}/approve` | Approve a transition proposal              | admin only |
| POST   | `/stock/lifecycle/proposals/{id}/reject`  | Reject a transition proposal               | admin only |
| GET    | `/stock/lifecycle/transitions`            | Allowed transitions                        | ✓          |

### Vendors — W4.08 vendors

| Method | Path                     | What                                                              | Panel      |
| ------ | ------------------------ | ----------------------------------------------------------------- | ---------- |
| GET    | `/vendors`               | Vendors                                                           | ✓          |
| POST   | `/vendors`               | Add vendor                                                        | admin only |
| GET    | `/vendors/{id}`          | Vendor detail (+ supplied SKUs)                                   | ✓          |
| PATCH  | `/vendors/{id}`          | Edit vendor                                                       | admin only |
| PUT    | `/vendors/{id}/variants` | Set supplied SKUs (ownership, lead time, MOQ, preferred, unit QR) | admin only |

### Restock & transfers — W4.07, W4.08

| Method | Path                                    | What                                                       | Panel      |
| ------ | --------------------------------------- | ---------------------------------------------------------- | ---------- |
| GET    | `/stock/restock-requests`               | Restock requests (W4.07 Submitted)                         | ✓          |
| POST   | `/stock/restock-requests`               | Create a restock request (draft)                           | ✓          |
| GET    | `/stock/restock-requests/{id}`          | Restock request + approval summary (W4.08)                 | ✓          |
| PATCH  | `/stock/restock-requests/{id}`          | Edit a draft request                                       | ✓          |
| POST   | `/stock/restock-requests/{id}/approve`  | Approve a restock request                                  | admin only |
| POST   | `/stock/restock-requests/{id}/cancel`   | Cancel a request                                           | ✓          |
| POST   | `/stock/restock-requests/{id}/dispatch` | Dispatch an approved transfer (source warehouse)           | ✓          |
| POST   | `/stock/restock-requests/{id}/reject`   | Reject a restock request                                   | admin only |
| POST   | `/stock/restock-requests/{id}/submit`   | Submit for approval (confirm modal)                        | ✓          |
| GET    | `/stock/restock-requests/prefill`       | Prefill products to replenish (W4.01 Plan restock / W4.08) | ✓          |
| GET    | `/stock/transfers`                      | Transfers (in / out)                                       | ✓          |
| GET    | `/stock/transfers/{id}`                 | Transfer detail                                            | ✓          |
| POST   | `/stock/transfers/{id}/receive`         | Receive a transfer (destination)                           | ✓          |

### Stock cutover — D-57a cutover (§2a.1)

| Method | Path                      | What                                   | Panel      |
| ------ | ------------------------- | -------------------------------------- | ---------- |
| GET    | `/stock/cutover`          | Cutover status (inventory → warehouse) | admin only |
| POST   | `/stock/cutover/abort`    | Abort the freeze                       | admin only |
| POST   | `/stock/cutover/freeze`   | Freeze stock writes (cutover step 2)   | admin only |
| POST   | `/stock/cutover/rollback` | Roll back to inventory (≤ 72 h)        | admin only |
| POST   | `/stock/cutover/run`      | Run the cutover (steps 3–6)            | admin only |

### Ops — jobs, DLQ, reconcile

| Method | Path                        | What                       | Panel      |
| ------ | --------------------------- | -------------------------- | ---------- |
| GET    | `/ops/jobs`                 | Background jobs            | admin only |
| POST   | `/ops/jobs/dlq/{id}/replay` | Replay a dead-lettered job | admin only |
| GET    | `/ops/maintenance`          | Maintenance banner         | ✓          |
| GET    | `/ops/reconcile`            | Latest reconcile report    | admin only |

### Order fulfilment — W3.01–W3.04, W3.15 hold

| Method | Path                                                 | What                                      | Panel      |
| ------ | ---------------------------------------------------- | ----------------------------------------- | ---------- |
| GET    | `/fulfilment/dashboard/fulfilment-rate`              | Dashboard: fulfilment-rate donut          | ✓          |
| GET    | `/fulfilment/dashboard/kpis`                         | Dashboard: 5 KPI cards                    | ✓          |
| GET    | `/fulfilment/dashboard/ops-status`                   | Dashboard: ops footer                     | ✓          |
| GET    | `/fulfilment/dashboard/recent-orders`                | Dashboard: recent orders                  | ✓          |
| GET    | `/fulfilment/dashboard/status-mix`                   | Dashboard: order status donut             | ✓          |
| GET    | `/fulfilment/dashboard/status-strip`                 | Dashboard: 8-status strip                 | ✓          |
| GET    | `/fulfilment/dashboard/trend`                        | Dashboard: orders vs fulfilled trend      | ✓          |
| GET    | `/fulfilment/dashboard/warehouse-performance`        | Dashboard: warehouse performance          | ✓          |
| GET    | `/fulfilment/nav-counts`                             | Sidebar badges                            | ✓          |
| GET    | `/fulfilment/orders`                                 | New Orders: list                          | ✓          |
| GET    | `/fulfilment/orders/{orderId}`                       | Order details (header, totals, actions)   | ✓          |
| GET    | `/fulfilment/orders/{orderId}/activity`              | Order activity timeline                   | ✓          |
| POST   | `/fulfilment/orders/{orderId}/allocate`              | Assign to a warehouse (reallocate)        | ✓          |
| GET    | `/fulfilment/orders/{orderId}/allocation-candidates` | Warehouse allocation candidates           | ✓          |
| GET    | `/fulfilment/orders/{orderId}/allocation-map`        | Warehouse allocation map                  | ✓          |
| GET    | `/fulfilment/orders/{orderId}/audit`                 | Order audit trail (W3.15)                 | ✓          |
| GET    | `/fulfilment/orders/{orderId}/customer`              | Order customer & farm                     | ✓          |
| GET    | `/fulfilment/orders/{orderId}/hold`                  | Hold parameters                           | ✓          |
| PATCH  | `/fulfilment/orders/{orderId}/hold`                  | Update hold (override expiration)         | ✓          |
| POST   | `/fulfilment/orders/{orderId}/hold`                  | Hold order                                | ✓          |
| GET    | `/fulfilment/orders/{orderId}/items`                 | Order items                               | ✓          |
| POST   | `/fulfilment/orders/{orderId}/release-hold`          | Release hold (back to picking)            | ✓          |
| GET    | `/fulfilment/orders/{orderId}/shelf-life-check`      | Shelf-life check (W3.15)                  | ✓          |
| GET    | `/fulfilment/orders/filter-options`                  | New Orders: PIN / customer filter options | ✓          |
| GET    | `/fulfilment/orders/kpis`                            | New Orders: KPIs + tab counts             | ✓          |
| GET    | `/fulfilment/reallocations/{id}`                     | Reallocation status                       | ✓          |
| GET    | `/fulfilment/settings`                               | Fulfilment settings                       | admin only |
| PUT    | `/fulfilment/settings`                               | Change fulfilment settings                | admin only |
| GET    | `/fulfilment/shelf-life-rules`                       | Shelf-life rules                          | ✓          |
| POST   | `/fulfilment/shelf-life-rules`                       | Create shelf-life rule                    | admin only |
| DELETE | `/fulfilment/shelf-life-rules/{id}`                  | Delete shelf-life rule                    | admin only |
| PATCH  | `/fulfilment/shelf-life-rules/{id}`                  | Update shelf-life rule                    | admin only |
| GET    | `/ops/reconcile/allocation`                          | Allocation reconcile report               | admin only |
| GET    | `/stock/reservations`                                | Reserved stock list (W4.05)               | ✓          |
| GET    | `/stock/reservations/{allocationId}`                 | Reservation detail                        | ✓          |
| GET    | `/stock/reservations/kpis`                           | Reserved stock KPIs (W4.05)               | ✓          |
| GET    | `/sync-status`                                       | Sync status (Live / SYNC)                 | ✓          |

### Fulfilment floor — W3.05–W3.07

| Method | Path                                                  | What                                  | Panel |
| ------ | ----------------------------------------------------- | ------------------------------------- | ----- |
| GET    | `/fulfilment/operators`                               | Operators (with open-task load)       | ✓     |
| GET    | `/fulfilment/processing`                              | Processing list                       | ✓     |
| POST   | `/fulfilment/processing/bulk`                         | Processing bulk update                | ✓     |
| GET    | `/fulfilment/processing/counts`                       | Processing stage tabs + live batch    | ✓     |
| GET    | `/fulfilment/processing/kpis`                         | Processing footer KPIs                | ✓     |
| GET    | `/fulfilment/shipments/{id}`                          | Shipment header (FEFO / assign)       | ✓     |
| GET    | `/fulfilment/shipments/{id}/allocation-summary`       | Allocation summary                    | ✓     |
| DELETE | `/fulfilment/shipments/{id}/allocations`              | Release allocations                   | ✓     |
| GET    | `/fulfilment/shipments/{id}/allocations`              | Pick list (allocated lots + bins)     | ✓     |
| POST   | `/fulfilment/shipments/{id}/allocations`              | Reserve stock (FEFO)                  | ✓     |
| POST   | `/fulfilment/shipments/{id}/allocations/change-batch` | Change batch                          | ✓     |
| GET    | `/fulfilment/shipments/{id}/lines`                    | Shipment lines (allocated x/y)        | ✓     |
| GET    | `/fulfilment/shipments/{id}/lines/{lineNo}/lots`      | FEFO lots of a line                   | ✓     |
| POST   | `/fulfilment/shipments/{id}/pack`                     | Pack                                  | ✓     |
| POST   | `/fulfilment/shipments/{id}/pick`                     | Pick units                            | ✓     |
| POST   | `/fulfilment/shipments/{id}/pick/complete`            | Pick complete                         | ✓     |
| POST   | `/fulfilment/shipments/{id}/qc`                       | QC result                             | ✓     |
| POST   | `/fulfilment/shipments/{id}/stage`                    | Stage (ready to dispatch)             | ✓     |
| POST   | `/fulfilment/shipments/{id}/tasks`                    | Assign pick-pack task                 | ✓     |
| GET    | `/fulfilment/task-templates/{type}`                   | Checklist template                    | ✓     |
| GET    | `/fulfilment/tasks`                                   | Tasks (my tasks)                      | ✓     |
| GET    | `/fulfilment/tasks/{taskId}`                          | Task detail                           | ✓     |
| PATCH  | `/fulfilment/tasks/{taskId}`                          | Reassign / reprioritise / cancel task | ✓     |
| PUT    | `/fulfilment/tasks/{taskId}/checklist/{key}`          | Tick checklist item                   | ✓     |
| POST   | `/fulfilment/tasks/batch`                             | Create pick batch (waves-lite)        | ✓     |

### Order exceptions — W3.11

| Method | Path                                  | What                                  | Panel      |
| ------ | ------------------------------------- | ------------------------------------- | ---------- |
| GET    | `/fulfilment/exceptions`              | Exceptions list                       | ✓          |
| POST   | `/fulfilment/exceptions`              | Raise an exception                    | ✓          |
| GET    | `/fulfilment/exceptions/{id}`         | Exception detail                      | ✓          |
| PATCH  | `/fulfilment/exceptions/{id}`         | Update exception                      | ✓          |
| POST   | `/fulfilment/exceptions/{id}/resolve` | Resolve exception                     | ✓          |
| POST   | `/fulfilment/exceptions/bulk`         | Mass re-route / hold / close / assign | ✓          |
| GET    | `/fulfilment/exceptions/export.csv`   | Export exceptions (CSV)               | ✓          |
| GET    | `/fulfilment/exceptions/kpis`         | Exceptions KPIs + tabs                | ✓          |
| GET    | `/settings/sop`                       | SOP card                              | ✓          |
| PUT    | `/settings/sop`                       | Edit SOP card                         | admin only |

### Delivery & settlement — W3.09, W3.10

| Method | Path                                             | What                                  | Panel |
| ------ | ------------------------------------------------ | ------------------------------------- | ----- |
| DELETE | `/dispatch/trips/{id}/driver-link`               | Revoke driver trip link               | ✓     |
| POST   | `/dispatch/trips/{id}/driver-link`               | Create 3PL driver trip link           | ✓     |
| GET    | `/exports`                                       | My exports                            | ✓     |
| POST   | `/exports`                                       | Request an export (POD archive / CSV) | ✓     |
| GET    | `/exports/{id}`                                  | Export status                         | ✓     |
| GET    | `/exports/{id}/download`                         | Download export (CSV)                 | ✓     |
| GET    | `/fulfilment/delivered`                          | Delivered orders (W3.09)              | ✓     |
| GET    | `/fulfilment/delivered/kpis`                     | Delivered KPIs                        | ✓     |
| GET    | `/fulfilment/fulfilled`                          | Fulfilled orders (W3.10)              | ✓     |
| GET    | `/fulfilment/fulfilled/kpis`                     | Fulfilled KPIs + tabs (W3.10)         | ✓     |
| POST   | `/fulfilment/shipments/{id}/deliver`             | Deliver with OTP + POD                | ✓     |
| POST   | `/fulfilment/shipments/{id}/deliver-override`    | Deliver without OTP (override)        | ✓     |
| POST   | `/fulfilment/shipments/{id}/delivery-failed`     | Delivery failed                       | ✓     |
| POST   | `/fulfilment/shipments/{id}/fulfil`              | Confirm final quantities (fulfil)     | ✓     |
| POST   | `/fulfilment/shipments/{id}/otp/resend`          | Send a new delivery code              | ✓     |
| POST   | `/fulfilment/shipments/{id}/out-for-delivery`    | Out for delivery (issue OTP)          | ✓     |
| GET    | `/fulfilment/shipments/{id}/pod`                 | View POD                              | ✓     |
| POST   | `/fulfilment/shipments/{id}/return-to-warehouse` | Return to warehouse                   | ✓     |
| POST   | `/fulfilment/shipments/{id}/settle`              | Settle now (prepaid reconciliation)   | ✓     |

### Dispatch & trips — W3.08, dispatch layer

| Method | Path                                                  | What                                         | Panel |
| ------ | ----------------------------------------------------- | -------------------------------------------- | ----- |
| GET    | `/dispatch/carriers`                                  | Carriers                                     | ✓     |
| POST   | `/dispatch/carriers`                                  | Create carrier                               | ✓     |
| PATCH  | `/dispatch/carriers/{id}`                             | Update carrier                               | ✓     |
| GET    | `/dispatch/drivers`                                   | Drivers                                      | ✓     |
| POST   | `/dispatch/drivers`                                   | Create driver                                | ✓     |
| PATCH  | `/dispatch/drivers/{id}`                              | Update driver                                | ✓     |
| GET    | `/dispatch/routes`                                    | Route master                                 | ✓     |
| POST   | `/dispatch/routes`                                    | Create route                                 | ✓     |
| PATCH  | `/dispatch/routes/{id}`                               | Update route                                 | ✓     |
| GET    | `/dispatch/trips`                                     | Trips                                        | ✓     |
| POST   | `/dispatch/trips`                                     | Plan a trip                                  | ✓     |
| GET    | `/dispatch/trips/{id}`                                | Trip detail                                  | ✓     |
| POST   | `/dispatch/trips/{id}/cancel`                         | Cancel trip (before departure)               | ✓     |
| POST   | `/dispatch/trips/{id}/complete`                       | Complete trip                                | ✓     |
| POST   | `/dispatch/trips/{id}/depart`                         | Depart (gate-out)                            | ✓     |
| POST   | `/dispatch/trips/{id}/loading`                        | Gate-in / loading progress                   | ✓     |
| POST   | `/dispatch/trips/{id}/pings`                          | Update tracking (ping)                       | ✓     |
| POST   | `/dispatch/trips/{id}/reassign`                       | Reassign vehicle / driver                    | ✓     |
| GET    | `/dispatch/trips/{id}/route`                          | Trip route (stops + breadcrumb)              | ✓     |
| POST   | `/dispatch/trips/{id}/shipments`                      | Add shipments to a trip                      | ✓     |
| DELETE | `/dispatch/trips/{id}/shipments/{shipmentId}`         | Remove a shipment from a trip                | ✓     |
| GET    | `/dispatch/trips/{id}/tracking`                       | Trip live tracking                           | ✓     |
| GET    | `/dispatch/trips/{id}/weighbridge`                    | Weighbridge slip                             | ✓     |
| POST   | `/dispatch/trips/{id}/weighbridge`                    | Record weighbridge (manual)                  | ✓     |
| GET    | `/dispatch/vehicles`                                  | Vehicles                                     | ✓     |
| POST   | `/dispatch/vehicles`                                  | Create vehicle                               | ✓     |
| PATCH  | `/dispatch/vehicles/{id}`                             | Update vehicle                               | ✓     |
| GET    | `/dispatch/weighbridge/recent`                        | Weighbridge recent                           | ✓     |
| GET    | `/fulfilment/dispatched`                              | Dispatched orders (W3.08 list)               | ✓     |
| GET    | `/fulfilment/shipments/{shipmentId}/dispatch-info`    | Dispatched order: dispatch info + route path | ✓     |
| GET    | `/fulfilment/shipments/{shipmentId}/dispatch-summary` | Dispatched order: top strip                  | ✓     |
| GET    | `/fulfilment/shipments/{shipmentId}/tracking`         | Dispatched order: live tracking              | ✓     |
| GET    | `/fulfilment/shipments/{shipmentId}/vehicle`          | Dispatched order: partner & vehicle          | ✓     |

### Bulk & direct-to-farm — W3.19

| Method | Path                      | What                               | Panel |
| ------ | ------------------------- | ---------------------------------- | ----- |
| GET    | `/bulk/bays`              | Heavy bay utilisation              | ✓     |
| GET    | `/bulk/corridors`         | Corridor map                       | ✓     |
| GET    | `/bulk/kpis`              | Bulk KPIs + tabs                   | ✓     |
| GET    | `/bulk/orders`            | Bulk / direct-to-farm consignments | ✓     |
| GET    | `/bulk/orders/export.csv` | Export bulk manifest (CSV)         | ✓     |

### Routing rules — W3.12

| Method | Path                               | What                                                          | Panel      |
| ------ | ---------------------------------- | ------------------------------------------------------------- | ---------- |
| GET    | `/routing/audit`                   | Audit Logs tab                                                | ✓          |
| GET    | `/routing/condition-catalog`       | Condition builder options                                     | ✓          |
| GET    | `/routing/fallback`                | Fallback Rules tab / W3.04 fallback policy                    | ✓          |
| PUT    | `/routing/fallback`                | Save the fallback policy                                      | admin only |
| GET    | `/routing/history`                 | Rule History tab                                              | ✓          |
| GET    | `/routing/node-load`               | Node Load Factor                                              | ✓          |
| POST   | `/routing/republish`               | Re-publish the routing snapshot                               | admin only |
| GET    | `/routing/rules`                   | Rule table (priority order)                                   | ✓          |
| POST   | `/routing/rules`                   | Add a rule                                                    | admin only |
| DELETE | `/routing/rules/{id}`              | Delete a rule (soft; history kept)                            | admin only |
| GET    | `/routing/rules/{id}`              | One rule                                                      | ✓          |
| PATCH  | `/routing/rules/{id}`              | Edit a rule (also publish / unpublish a draft, move priority) | admin only |
| POST   | `/routing/rules/{id}/disable`      | Disable a rule (toggle off)                                   | admin only |
| POST   | `/routing/rules/{id}/duplicate`    | Duplicate a rule (row ⋮)                                      | admin only |
| POST   | `/routing/rules/{id}/enable`       | Enable a rule (toggle on)                                     | admin only |
| GET    | `/routing/rules/{id}/history`      | Rule history (row ⋮)                                          | ✓          |
| GET    | `/routing/rules/export.csv`        | Export rules (CSV)                                            | ✓          |
| PUT    | `/routing/rules/order`             | Drag reorder                                                  | admin only |
| POST   | `/routing/simulate`                | Rule Simulation (decision tree)                               | ✓          |
| POST   | `/routing/simulate-matrix`         | Test Matrix                                                   | ✓          |
| GET    | `/routing/summary`                 | Header counts (active, inactive, draft, routed %)             | ✓          |
| PUT    | `/routing/throttles/{warehouseId}` | Adjust throttle of a node                                     | admin only |

### Available-to-promise — W3.13

| Method | Path                     | What                                                 | Panel      |
| ------ | ------------------------ | ---------------------------------------------------- | ---------- |
| GET    | `/atp/categories`        | Category tabs with SKU counts                        | ✓          |
| GET    | `/atp/items`             | ATP table                                            | ✓          |
| GET    | `/atp/items/export.csv`  | Export ATP (CSV)                                     | ✓          |
| GET    | `/atp/kpis`              | 6 KPI cards (+ availability rate)                    | ✓          |
| GET    | `/atp/node-distribution` | Node distribution + transfer pipeline                | ✓          |
| GET    | `/atp/settings`          | Formula, health bands, buffer floor, cart-hold lease | ✓          |
| PUT    | `/atp/settings`          | Save ATP settings                                    | admin only |
| POST   | `/atp/sync`              | Sync Now (re-send storefront availability)           | ✓          |

### Split, partial & backorder — W3.14

| Method | Path                                          | What                                                      | Panel |
| ------ | --------------------------------------------- | --------------------------------------------------------- | ----- |
| GET    | `/fulfilment/backorders`                      | Backorder queue                                           | ✓     |
| PATCH  | `/fulfilment/backorders/{id}`                 | Change promise date / note                                | ✓     |
| POST   | `/fulfilment/backorders/{id}/cancel`          | Cancel a backorder (refund)                               | ✓     |
| GET    | `/fulfilment/dispatch-slots`                  | Dispatch slots of a node                                  | ✓     |
| POST   | `/fulfilment/orders/{orderId}/partial`        | Partial fulfilment                                        | ✓     |
| POST   | `/fulfilment/orders/{orderId}/reroute`        | Cancel & re-route the whole order                         | ✓     |
| POST   | `/fulfilment/orders/{orderId}/split`          | Save & Execute the split                                  | ✓     |
| GET    | `/fulfilment/orders/{orderId}/split-context`  | Order header, shortage banner, node fit                   | ✓     |
| GET    | `/fulfilment/orders/{orderId}/split-map`      | Corridors map                                             | ✓     |
| POST   | `/fulfilment/orders/{orderId}/split-preview`  | Plan summary, freight policy, customer notice, SOP checks | ✓     |
| GET    | `/fulfilment/orders/{orderId}/split-proposal` | Proposed legs for a strategy                              | ✓     |

### Order hold & edit — W3.15

| Method | Path                                            | What                                   | Panel |
| ------ | ----------------------------------------------- | -------------------------------------- | ----- |
| POST   | `/fulfilment/orders/{orderId}/amendments`       | Save & update order changes            | ✓     |
| POST   | `/fulfilment/orders/{orderId}/amendments/quote` | Amendment quote (what a save would do) | ✓     |
| GET    | `/fulfilment/shipments/{id}/manifest`           | Shipment manifest                      | ✓     |

### Compliance check — W3.16

| Method | Path                                               | What                                                 | Panel      |
| ------ | -------------------------------------------------- | ---------------------------------------------------- | ---------- |
| GET    | `/compliance/audit/export.csv`                     | Export compliance audit log (CSV)                    | ✓          |
| GET    | `/compliance/cases`                                | Compliance cases                                     | ✓          |
| GET    | `/compliance/cases/{id}`                           | Case detail (checklist, inspector, notes, documents) | ✓          |
| POST   | `/compliance/cases/{id}/checks/{checkId}/decision` | Verify / reject one check                            | ✓          |
| POST   | `/compliance/cases/{id}/checks/{checkId}/request`  | Request a document from the customer                 | ✓          |
| POST   | `/compliance/cases/{id}/decision`                  | Approve & release / Hold / Reject                    | ✓          |
| POST   | `/compliance/cases/{id}/documents`                 | Attach a document to a check                         | ✓          |
| GET    | `/compliance/cases/{id}/evidence`                  | Case evidence                                        | ✓          |
| POST   | `/compliance/cases/{id}/evidence`                  | Add extra evidence (scan slip, declaration)          | ✓          |
| PUT    | `/compliance/cases/{id}/inspector`                 | Assign inspector                                     | ✓          |
| POST   | `/compliance/cases/{id}/notes`                     | Add a note                                           | ✓          |
| GET    | `/compliance/cases/{id}/restricted-ledger`         | Restricted drug ledger                               | ✓          |
| POST   | `/compliance/cases/{id}/waiver`                    | Waive checks (Form 19)                               | ✓          |
| GET    | `/compliance/inspectors`                           | Inspectors                                           | ✓          |
| PUT    | `/compliance/inspectors/{userId}`                  | Save an inspector                                    | admin only |
| GET    | `/compliance/kpis`                                 | Compliance tab counts + KPI chips                    | ✓          |
| GET    | `/compliance/registry`                             | Regulatory registry                                  | ✓          |
| PUT    | `/compliance/registry/{key}`                       | Save a registry rule                                 | admin only |

### Payments (prepaid) — W3.18

| Method | Path                                | What                                   | Panel |
| ------ | ----------------------------------- | -------------------------------------- | ----- |
| GET    | `/payments-view/customers/{userId}` | Customer panel                         | ✓     |
| GET    | `/payments-view/kpis`               | KPI cards                              | ✓     |
| GET    | `/payments-view/orders`             | Payment ledger                         | ✓     |
| GET    | `/payments-view/orders/export.csv`  | Export ledger (CSV)                    | ✓     |
| GET    | `/payments-view/sla`                | Reconciliation SLA (payment clearance) | ✓     |

### Driver (3PL link)

| Method | Path                                                       | What                                  |
| ------ | ---------------------------------------------------------- | ------------------------------------- |
| GET    | `/v1/driver/trips/{token}`                                 | Driver: trip stops and drops          |
| POST   | `/v1/driver/trips/{token}/pings`                           | Driver: send position                 |
| POST   | `/v1/driver/trips/{token}/shipments/{id}/deliver`          | Driver: deliver with the customer OTP |
| POST   | `/v1/driver/trips/{token}/shipments/{id}/delivery-failed`  | Driver: delivery failed               |
| POST   | `/v1/driver/trips/{token}/shipments/{id}/out-for-delivery` | Driver: out for delivery              |

### Customer shipments

| Method | Path            | What         |
| ------ | --------------- | ------------ |
| GET    | `/v1/shipments` | My shipments |

### Not built (modules flags)

- W3.17 Scheduled & repeat orders, W3.18 credit, W3.19 "Create bulk order": later phase (prepaid only today; `modules.credit=false`).
- W3.15 quantity increase: needs a balance payment (`modules.balancePayment=false`; place an add-on order).
- Driver-link SMS (`modules.sms=false`, the link is returned to the dispatcher), state portal, OCR, RFID / Fastag, Shopify.
- Per-leg planned trips for a split: legs return a dispatch slot + fleet suggestion; trips are created with `POST /dispatch/trips`.

## D-62 · Gate & Weighbridge (W5)

Generated from the Swagger spec (2026-11-25). Panel prefix `/v1/wms` (scoped to the caller's warehouses);
the same handlers answer on `/v1/admin/wms` (GLOBAL grants). Setup routes live under
`/v1/admin/warehouses/:id`. Every write accepts `Idempotency-Key`; cached dashboard reads return an
`ETag` (send `If-None-Match` → 304). Decision record: `docs/decisions.md` D-62.

**Flow:** ASN (W5.12) → dock appointment (W5.11) → inbound shipment `INB` (W5.02–W5.04) → gate entry `GE`

- gross (W5.05) → documents (W5.06) → approve → inward pass `GPI` (W5.07) → handover / GP-IN scan →
  CN receipts (`POST /stock/receipts {gateEntryId, finalForGate}`) or manual unloaded → tare + reconciliation
  (W5.09 / W5.10) → outward pass `GPO` → exit. Side paths: block / unblock, turn-away (before unloading) with
  exit check, HELD (breach / no declared weight) → accept / reweigh / debit note, manual override (maker ≠
  checker), visitors / outward material / security checks (W5.13).

**Screen → calls (each widget its own call, parallel):**

| Screen                           | Calls                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W5.01 Gate dashboard             | `GET /gate/summary` · `/gate/status-mix` · `/gate/activity` · `/gate/shipments?tab=…` · `/gate/shipments/counts` (+ `/gate/lookups`, `/gate/bays` for the filter modal)                                |
| W5.01a Empty state               | `GET /gate/summary` → `emptyState` (today's entries, total exit, in progress, scheduled today)                                                                                                         |
| W5.02–W5.04 Create shipment      | `GET /gate/lookups`, `/vendors`, `/gate/purchase-orders`, `/gate/products`, `POST /v1/upload?purpose=gate_document` → `POST /gate/shipments/preview` → `POST /gate/shipments`                          |
| W5.05 / 05a Gate entry           | `GET /gate/arrivals`, `/gate/scales`, `/gate/bays` → `POST /gate/entries` (optional `gross`)                                                                                                           |
| W5.06 / 06a–d Documents          | `GET /gate/entries/:id`, `/gate/entries/:id/documents`, `/gate/documents/:docId/preview` → `POST /gate/documents/:docId/verify`, `/gate/entries/:id/approve` or `/block` (`/unblock`, `/turn-away`)    |
| W5.07 / 07a / 07b Gate pass      | `GET /gate/entries/:id/passes`, `/gate/passes/:passNo/pdf` → `POST /gate/passes/scan` or `/gate/entries/:id/handover` → `/unloaded`, `GET /gate/entries/:id/receipts`                                  |
| W5.08 Entry details              | `GET /gate/entries/:id` · `/gate/shipments/:id/lines` · `/gate/entries/:id/documents` · `/gate/entries/:id/timeline` (live route → NOT_AVAILABLE)                                                      |
| W5.09 / 09a–d Exit & tare        | `GET /gate/weighbridge/lookup` → `POST /gate/entries/:id/weighments {kind: TARE}` → `GET /gate/entries/:id/reconciliation` → `POST /outward-pass` → `POST /exit` (`GET /weighment-slip.pdf`)           |
| W5.10 / 10a–c Weighbridge        | `GET /gate/entries/:id/weighments`, `/reconciliation`, `/gate/scales` → `POST /weighments`, `/hold`, `/hold/resolve`, `/gate/weighments/:id/override` → `/review` (`GET /gate/approvals`)              |
| W5.11 / 11a Dock slots           | `GET /gate/appointments/summary` · `/slots` · `/gate/appointments` · `/bays` → `POST /gate/appointments`, `PATCH /:id`, `POST /:id/confirm`, `/:id/cancel`                                             |
| W5.12 / 12a Vendor ASN           | `GET /gate/asns/summary` · `/gate/asns` · `/gate/asns/:id` → `POST /gate/asns`, `/:id/match`, `/:id/convert`                                                                                           |
| W5.13 / 13a–c Visitor & security | `GET /gate/security/summary` · `/gate/visitors` · `/gate/outward-materials` · `/gate/security-checks` → `POST` visitor / outward / check, `/check-in`, `/check-out`, `/authorize`, `/exit`, `/resolve` |
| Setup                            | `/v1/admin/warehouses/:id/weigh-scales` (CRUD), `/gate-settings` (GET / PUT)                                                                                                                           |

**All operations (87):**

| Area                               | Route                                                  | Summary                                                                 | Permission       |
| ---------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------- |
| Admin Warehouses · Gate setup      | `DELETE /admin/warehouses/{id}/weigh-scales/{scaleId}` | Delete an unused scale                                                  | `gate.configure` |
| Admin Warehouses · Gate setup      | `GET /admin/warehouses/{id}/gate-settings`             | Gate settings (effective values)                                        | `gate.view`      |
| Admin Warehouses · Gate setup      | `GET /admin/warehouses/{id}/weigh-scales`              | Weighbridge scales of a warehouse                                       | `gate.view`      |
| Admin Warehouses · Gate setup      | `PATCH /admin/warehouses/{id}/weigh-scales/{scaleId}`  | Edit a scale (calibration, status)                                      | `gate.configure` |
| Admin Warehouses · Gate setup      | `POST /admin/warehouses/{id}/weigh-scales`             | Add a weighbridge scale                                                 | `gate.configure` |
| Admin Warehouses · Gate setup      | `PUT /admin/warehouses/{id}/gate-settings`             | Override gate settings for this warehouse                               | `gate.configure` |
| Gate · Dashboard & shipments       | `DELETE /gate/shipments/{id}/documents/{docId}`        | Remove an unverified document                                           | `gate.operate`   |
| Gate · Dashboard & shipments       | `GET /gate/activity`                                   | W5.01 Recent activity (gate in / out, weighed, blocked)                 | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/bays`                                       | Inbound bays (unloading doors) and status now                           | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/documents/{docId}/preview`                  | W5.06a Document preview (5-minute signed URL)                           | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/lookups`                                    | Gate lookups (types, purposes, documents, reasons, tolerance)           | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/products`                                   | Product search for shipment lines (name / SKU, pack, weight)            | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/purchase-orders`                            | Open purchase orders (approved procurement requests) with remaining qty | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/shipments/counts`                           | W5.01 Tab badges (All / Expected / Arrived / In progress / Blocked)     | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/shipments/{id}/lines`                       | Products manifest of a shipment                                         | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/shipments/{id}`                             | Inbound shipment (review / view)                                        | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/shipments`                                  | W5.01 Inbound shipments table (tabs, search, bay, dates)                | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/status-mix`                                 | W5.01 Vehicle Entry Status donut                                        | `gate.view`      |
| Gate · Dashboard & shipments       | `GET /gate/summary`                                    | W5.01 KPI cards + empty-state cards                                     | `gate.view`      |
| Gate · Dashboard & shipments       | `PATCH /gate/shipments/{id}`                           | Edit an expected shipment                                               | `gate.operate`   |
| Gate · Dashboard & shipments       | `POST /gate/shipments/preview`                         | W5.02–W5.04 Wizard preview (no write)                                   | `gate.operate`   |
| Gate · Dashboard & shipments       | `POST /gate/shipments/{id}/cancel`                     | Cancel an expected shipment (soft delete)                               | `gate.operate`   |
| Gate · Dashboard & shipments       | `POST /gate/shipments/{id}/documents`                  | Attach a document (upload receipt and/or reference)                     | `gate.operate`   |
| Gate · Dashboard & shipments       | `POST /gate/shipments`                                 | W5.04 Save inbound shipment                                             | `gate.operate`   |
| Gate · Dock appointments & ASN     | `GET /gate/appointments/bays`                          | W5.11 Bay cards                                                         | `gate.view`      |
| Gate · Dock appointments & ASN     | `GET /gate/appointments/slots`                         | W5.11 Time-slot strip of a day                                          | `gate.view`      |
| Gate · Dock appointments & ASN     | `GET /gate/appointments/summary`                       | W5.11 KPI cards (slots, booked, available, delayed)                     | `gate.view`      |
| Gate · Dock appointments & ASN     | `GET /gate/appointments/{id}`                          | One dock appointment                                                    | `gate.view`      |
| Gate · Dock appointments & ASN     | `GET /gate/appointments`                               | W5.11 Booked vendor appointments                                        | `gate.view`      |
| Gate · Dock appointments & ASN     | `GET /gate/asns/summary`                               | W5.12 ASN KPI cards                                                     | `gate.view`      |
| Gate · Dock appointments & ASN     | `GET /gate/asns/{id}`                                  | W5.12 ASN detail card                                                   | `gate.view`      |
| Gate · Dock appointments & ASN     | `GET /gate/asns`                                       | W5.12 Incoming advance shipping notices                                 | `gate.view`      |
| Gate · Dock appointments & ASN     | `PATCH /gate/appointments/{id}`                        | Reschedule a dock appointment                                           | `gate.operate`   |
| Gate · Dock appointments & ASN     | `POST /gate/appointments/{id}/cancel`                  | Cancel a dock appointment                                               | `gate.operate`   |
| Gate · Dock appointments & ASN     | `POST /gate/appointments/{id}/confirm`                 | Mark an appointment confirmed by the vendor                             | `gate.operate`   |
| Gate · Dock appointments & ASN     | `POST /gate/appointments`                              | W5.11a Book a dock appointment                                          | `gate.operate`   |
| Gate · Dock appointments & ASN     | `POST /gate/asns/{id}/convert`                         | Create shipment from ASN (all or some lines)                            | `gate.operate`   |
| Gate · Dock appointments & ASN     | `POST /gate/asns/{id}/match`                           | W5.12a Match ASN to purchase order                                      | `gate.operate`   |
| Gate · Dock appointments & ASN     | `POST /gate/asns`                                      | Record a vendor ASN                                                     | `gate.operate`   |
| Gate · Entries, documents & passes | `GET /gate/arrivals`                                   | W5.05 Expected arrivals (shipment dropdown, prefilled)                  | `gate.view`      |
| Gate · Entries, documents & passes | `GET /gate/entries/{id}/documents`                     | W5.06 Document checklist + KPI cards + clearance hint                   | `gate.view`      |
| Gate · Entries, documents & passes | `GET /gate/entries/{id}/passes`                        | W5.07 Gate passes + QR + handover chips                                 | `gate.view`      |
| Gate · Entries, documents & passes | `GET /gate/entries/{id}/receipts`                      | Goods receipts (CN) linked to the entry                                 | `gate.view`      |
| Gate · Entries, documents & passes | `GET /gate/entries/{id}/timeline`                      | W5.08 Timeline (gate events)                                            | `gate.view`      |
| Gate · Entries, documents & passes | `GET /gate/entries/{id}`                               | Gate entry details (W5.05 / W5.08)                                      | `gate.view`      |
| Gate · Entries, documents & passes | `GET /gate/entries`                                    | Entries unloaded without a goods receipt (W6 follow-up)                 | `gate.view`      |
| Gate · Entries, documents & passes | `GET /gate/passes/{passNo}/pdf`                        | W5.07a Gate pass PDF (print / download)                                 | `gate.view`      |
| Gate · Entries, documents & passes | `PATCH /gate/entries/{id}`                             | Correct vehicle / driver / bay before approval                          | `gate.operate`   |
| Gate · Entries, documents & passes | `POST /gate/documents/{docId}/verify`                  | Verify / reject / exempt a document                                     | `gate.operate`   |
| Gate · Entries, documents & passes | `POST /gate/entries/{id}/approve`                      | W5.06b Approve entry → inward gate pass                                 | `gate.approve`   |
| Gate · Entries, documents & passes | `POST /gate/entries/{id}/block`                        | W5.06c Block gate entry                                                 | `gate.operate`   |
| Gate · Entries, documents & passes | `POST /gate/entries/{id}/cancel`                       | Cancel a gate entry created by mistake (ARRIVED only)                   | `gate.operate`   |
| Gate · Entries, documents & passes | `POST /gate/entries/{id}/handover`                     | W5.07 Proceed to receiving (handover)                                   | `gate.operate`   |
| Gate · Entries, documents & passes | `POST /gate/entries/{id}/turn-away`                    | Turn the truck away (before unloading)                                  | `gate.approve`   |
| Gate · Entries, documents & passes | `POST /gate/entries/{id}/unblock`                      | Unblock (resume where it paused)                                        | `gate.approve`   |
| Gate · Entries, documents & passes | `POST /gate/entries/{id}/unloaded`                     | W5.07b Unloading complete (manual)                                      | `gate.operate`   |
| Gate · Entries, documents & passes | `POST /gate/entries`                                   | W5.05 Gate entry (+ optional gross weight)                              | `gate.operate`   |
| Gate · Entries, documents & passes | `POST /gate/passes/scan`                               | Scan a gate pass QR (receiving desk / exit gate)                        | `gate.operate`   |
| Gate · Entries, documents & passes | `POST /gate/passes/{passNo}/reissue`                   | Reissue a gate pass (expired / damaged)                                 | `gate.approve`   |
| Gate · Visitors & security         | `GET /gate/outward-materials`                          | W5.13 Outward material register                                         | `gate.view`      |
| Gate · Visitors & security         | `GET /gate/security-checks`                            | W5.13 Recent security checks                                            | `gate.view`      |
| Gate · Visitors & security         | `GET /gate/security/summary`                           | W5.13 KPI cards                                                         | `gate.view`      |
| Gate · Visitors & security         | `GET /gate/visitors/{id}`                              | One visitor                                                             | `gate.view`      |
| Gate · Visitors & security         | `GET /gate/visitors`                                   | W5.13 Visitor and contractor register                                   | `gate.view`      |
| Gate · Visitors & security         | `POST /gate/outward-materials/{id}/authorize`          | Authorize / reject outward material                                     | `gate.approve`   |
| Gate · Visitors & security         | `POST /gate/outward-materials/{id}/exit`               | Outward material leaves                                                 | `gate.security`  |
| Gate · Visitors & security         | `POST /gate/outward-materials/{id}/reject`             | Authorize / reject outward material                                     | `gate.approve`   |
| Gate · Visitors & security         | `POST /gate/outward-materials`                         | W5.13b Record outward material (OM pass)                                | `gate.security`  |
| Gate · Visitors & security         | `POST /gate/security-checks/{id}/resolve`              | Resolve a security hold                                                 | `gate.approve`   |
| Gate · Visitors & security         | `POST /gate/security-checks`                           | W5.13c Save a security check                                            | `gate.security`  |
| Gate · Visitors & security         | `POST /gate/visitors/{id}/check-in`                    | Visitor check-in / check-out / deny                                     | `gate.security`  |
| Gate · Visitors & security         | `POST /gate/visitors/{id}/check-out`                   | Visitor check-in / check-out / deny                                     | `gate.security`  |
| Gate · Visitors & security         | `POST /gate/visitors/{id}/deny`                        | Visitor check-in / check-out / deny                                     | `gate.security`  |
| Gate · Visitors & security         | `POST /gate/visitors`                                  | W5.13a Record visitor entry                                             | `gate.security`  |
| Gate · Weighbridge                 | `GET /gate/approvals`                                  | Supervisor inbox (overrides, holds, security holds)                     | `gate.view`      |
| Gate · Weighbridge                 | `GET /gate/entries/{id}/reconciliation`                | W5.09b / W5.10 Net weight reconciliation + tolerance                    | `gate.view`      |
| Gate · Weighbridge                 | `GET /gate/entries/{id}/weighment-slip.pdf`            | Weighment slip PDF                                                      | `gate.view`      |
| Gate · Weighbridge                 | `GET /gate/entries/{id}/weighments`                    | W5.09 / W5.10 Weighments (gross, tare, KPI row, history)                | `gate.view`      |
| Gate · Weighbridge                 | `GET /gate/scales`                                     | Weighbridge scales (calibration, method, last weighed)                  | `gate.view`      |
| Gate · Weighbridge                 | `GET /gate/weighbridge/lookup`                         | W5.09 Find the active entry of a vehicle + next reading                 | `gate.view`      |
| Gate · Weighbridge                 | `POST /gate/entries/{id}/exit`                         | W5.09d Confirm exit                                                     | `gate.operate`   |
| Gate · Weighbridge                 | `POST /gate/entries/{id}/hold/resolve`                 | Resolve a hold (accept / reweigh / debit note)                          | `gate.approve`   |
| Gate · Weighbridge                 | `POST /gate/entries/{id}/hold`                         | W5.10b Record a weight hold                                             | `gate.operate`   |
| Gate · Weighbridge                 | `POST /gate/entries/{id}/outward-pass`                 | W5.09c Issue the outward gate pass                                      | `gate.operate`   |
| Gate · Weighbridge                 | `POST /gate/entries/{id}/weighments`                   | Capture a reading (gross / tare / exit check)                           | `gate.operate`   |
| Gate · Weighbridge                 | `POST /gate/weighments/{id}/override`                  | W5.10c Manual weighment override (save for review)                      | `gate.operate`   |
| Gate · Weighbridge                 | `POST /gate/weighments/{id}/review`                    | Approve / reject a manual weighment                                     | `gate.approve`   |
