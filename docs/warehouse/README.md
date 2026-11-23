# Warehouse portal backend: warehouse-service (:3014, D-56)

For the frontend team building the warehouse portal (Login + Multi-Warehouse). Every path below is
on the gateway (`/v1/...`); all responses use the standard envelope. Swagger: `/api-docs`, tags
**Admin Warehouses**, **Admin Warehouse Service Areas**, **Admin Warehouse Storage**, **Admin
Warehouse Dock & Yard**, **Admin Warehouse Calendar**, **Admin Warehouse Storage Rules**, **Admin
Warehouse Team**, **Warehouse Portal**.

## Status

| Phase | Scope                                                                                     | State |
| ----- | ----------------------------------------------------------------------------------------- | ----- |
| P0    | Warehouse-scoped permissions, invite-only staff, event contracts                          | ✅    |
| P1    | warehouse-service, warehouse master + wizard step 1 + status, service areas, portal shell | ✅    |
| P2    | Storage (zones/racks/bins), dock & yard, calendar & shifts, storage rules, team           | ✅    |
| P3    | Stock / capacity numbers, W2.03 overview, active orders                                   | ✅    |

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
