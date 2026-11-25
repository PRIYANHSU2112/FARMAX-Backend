import Joi from 'joi';

import { IF_VERSION, wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

export const DISPATCH_AREA = 'Dispatch & trips';
export const BULK_AREA = 'Bulk & direct-to-farm';

const any = Joi.object().unknown(true);
const list = Joi.array().items(any);
const PAGED =
  'Keyset paging (`cursor`) or numbered `page` (offset ≤ 2,000; total exact up to 10,000).';

export const dispatchDocs = (aud: 'panel' | 'admin') => {
  const D = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, DISPATCH_AREA, s, p, o);
  const B = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, BULK_AREA, s, p, o);
  return {
    routes: D('Route master', 'fulfilment.view', {
      data: list,
      description:
        'Named routes ("Route #8 – South Corridor") with PIN list, districts, corridor and stops; a shipment gets the route whose PIN list holds its delivery PIN on release.',
    }),
    routeCreate: D('Create route', 'logistics.fleet_manage', {
      status: 201,
      data: any,
      errors: [404, 409, 422],
    }),
    routePatch: D('Update route', 'logistics.fleet_manage', {
      data: any,
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    carriers: D('Carriers', 'fulfilment.view', {
      data: list,
      description: 'Own fleet and 3PL partners.',
    }),
    carrierCreate: D('Create carrier', 'logistics.fleet_manage', {
      status: 201,
      data: any,
      errors: [422],
    }),
    carrierPatch: D('Update carrier', 'logistics.fleet_manage', {
      data: any,
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    vehicles: D('Vehicles', 'fulfilment.view', {
      data: list,
      description: '`available=1` = active and not on a running trip.',
    }),
    vehicleCreate: D('Create vehicle', 'logistics.fleet_manage', {
      status: 201,
      data: any,
      errors: [409, 422],
      description: '409 DUPLICATE_REG_NO.',
    }),
    vehiclePatch: D('Update vehicle', 'logistics.fleet_manage', {
      data: any,
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    drivers: D('Drivers', 'fulfilment.view', {
      data: list,
      description:
        'Own-fleet drivers may have a staff account (`userId`); 3PL drivers use trip links (Phase 4b).',
    }),
    driverCreate: D('Create driver', 'logistics.fleet_manage', {
      status: 201,
      data: any,
      errors: [422],
    }),
    driverPatch: D('Update driver', 'logistics.fleet_manage', {
      data: any,
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    tripCreate: D('Plan a trip', 'logistics.dispatch_assign', {
      status: 201,
      data: any,
      errors: [404, 409, 422],
      description:
        'Shipments of one warehouse (allocated … ready), vehicle (capacity check), driver, carrier, route / stops, dock door, planned departure. One consignment may ride several trucks (many-to-many). 409 VEHICLE_BUSY / DRIVER_BUSY.',
    }),
    trips: D('Trips', 'fulfilment.view', {
      paginated: true,
      data: list,
      meta: PAGE_META,
      description: `Filters: status, type (BULK = W3.19 dispatch plan), vehicle, trip no. ${PAGED}`,
    }),
    trip: D('Trip detail', 'fulfilment.view', { data: any }),
    tripShipments: D('Add shipments to a trip', 'logistics.dispatch_assign', {
      data: any,
      errors: [404, 409, 422],
    }),
    tripShipmentRemove: D('Remove a shipment from a trip', 'logistics.dispatch_assign', {
      data: any,
      errors: [404, 409],
    }),
    loading: D('Gate-in / loading progress', 'logistics.dispatch_assign', {
      data: any,
      errors: [404, 409, 422],
    }),
    weigh: D('Record weighbridge (manual)', 'logistics.dispatch_assign', {
      data: any,
      errors: [404, 409, 422],
      description:
        'Gross − tare = net; verified when within weighTolerancePct of the loaded / planned payload ("Net: 30.12 T Verified"). Slip as a media receipt.',
    }),
    weighView: D('Weighbridge slip', 'fulfilment.view', { data: any }),
    weighRecent: D('Weighbridge recent', 'fulfilment.view', {
      data: list,
      description: 'Live device integration is not built (`modules.liveWeighbridge`).',
    }),
    depart: D('Depart (gate-out)', 'logistics.dispatch_assign', {
      data: any,
      errors: [404, 409, 503],
      description:
        'Every shipment must be READY_TO_DISPATCH and not on hold. **D-61: no goods leave without a GST invoice** — step 1 issues (or replays) each shipment’s tax invoice at order-service (idempotent per shipment + packed lines; a shipment whose packed lines changed gets its old invoice voided by a credit note and a new one), step 2 dispatches and re-checks the invoiced lines under the shipment lock. Each → DISPATCHED: packed lots leave, `shipment.dispatched.v1` (one dispatchId) makes inventory issue the reservation line once. The response adds `invoices[]` (`invoiceNo`, `grandTotal`, `replacedInvoiceNo`, `ewayBillRequired` when the value is above the e-way bill threshold — warning only). 409 NOT_READY / ON_HOLD / VEHICLE_OR_DRIVER_MISSING / TRIP_LOCKED / **INVOICE_BLOCKED** (order-service refused: `details.invoice.issues`) / **INVOICE_STALE** (lines changed between steps: depart again) · 503 INVOICE_UNAVAILABLE (nothing departed; retry).',
    }),
    complete: D('Complete trip', 'logistics.dispatch_assign', { data: any, errors: [404, 409] }),
    cancel: D('Cancel trip (before departure)', 'logistics.dispatch_assign', {
      data: any,
      errors: [404, 409, 422],
    }),
    reassign: D('Reassign vehicle / driver', 'logistics.dispatch_assign', {
      data: any,
      errors: [404, 409, 422],
      description: 'Reason required; audited.',
    }),
    ping: D('Update tracking (ping)', 'logistics.consignment_view', {
      data: any,
      errors: [404, 409, 422],
      description:
        'Stored at most once per pingMinIntervalSec (30 s) per trip; the trip keeps the latest position either way. 60 per minute.',
    }),
    route: D('Trip route (stops + breadcrumb)', 'fulfilment.view', { data: any }),
    tracking: D('Trip live tracking', 'fulfilment.view', {
      data: any,
      description:
        'Speed, km left, position, ping age, network, next milestone (next stop not passed) + ETA.',
    }),
    dispatched: D('Dispatched orders (W3.08 list)', 'fulfilment.view', {
      paginated: true,
      data: list,
      meta: PAGE_META,
      description: PAGED,
    }),
    summary: D('Dispatched order: top strip', 'fulfilment.view', {
      data: any,
      description: 'Bay, gross weight, transit status / ETA, destination.',
    }),
    vehicle: D('Dispatched order: partner & vehicle', 'fulfilment.view', { data: any }),
    shipTracking: D('Dispatched order: live tracking', 'fulfilment.view', { data: any }),
    info: D('Dispatched order: dispatch info + route path', 'fulfilment.view', {
      data: any,
      description:
        'Assigned time, gate-out on time, ETA, consignment status, corridor, stops with PASSED / NEXT / UPCOMING.',
    }),
    bulkKpis: B('Bulk KPIs + tabs', 'fulfilment.view', {
      data: any,
      description:
        'Active consignments (payload ≥ bulkMinKg), direct-to-farm (from the mother warehouse), new today, ready, in transit, vehicles, trips active / loading. RFID / Fastag are `modules` flags.',
    }),
    bulkOrders: B('Bulk / direct-to-farm consignments', 'fulfilment.view', {
      paginated: true,
      data: list,
      meta: PAGE_META,
      description: `Consignment BLK-…, customer, tonnes, slot (dock door) or "Unscheduled", trucks ("Truck 2: awaiting driver"). ${PAGED}`,
    }),
    bays: B('Heavy bay utilisation', 'fulfilment.view', {
      data: any,
      description:
        'Dock doors with equipment (hopper / conveyor / scale / weighbridge), current loading %, queue of planned trips, avg turnaround (gate-in → gate-out, 7 days).',
    }),
    corridors: B('Corridor map', 'fulfilment.view', { data: list }),
    bulkCsv: B('Export bulk manifest (CSV)', 'fulfilment.view', {
      description: 'Streamed; 5 per minute.',
    }),
  };
};
