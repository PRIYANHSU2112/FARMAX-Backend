import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { stateName } from '../warehouses/index.js';

/**
 * Which portal screens have a backend yet (the sidebar hides or greys the rest). Flipped on as
 * each D-56 phase ships; the dashboard (W1) and floor modules are out of scope for now.
 */
export const MODULES = {
  multiWarehouse: true,
  serviceAreas: true,
  storage: true,
  team: true,
  docks: true,
  calendar: true,
  storageRules: true,
  stockStats: true,
  orders: true,
  dashboard: false,
  putaway: false,
} as const;

const PIN = /^[1-9]\d{5}$/;

export interface SearchResult {
  type:
    | 'warehouse'
    | 'pin'
    | 'bin'
    | 'sku'
    | 'batch'
    | 'unit'
    | 'receipt'
    | 'restock'
    | 'transfer'
    | 'gate_shipment'
    | 'gate_entry'
    | 'gate_pass';
  id: string;
  title: string;
  subtitle: string;
  /** null for a SKU (stocked in several warehouses). */
  warehouseId: string | null;
}

/** The portal shell (D-56): who am I, which warehouses, header search. */
export class PortalService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'warehousesService'
      | 'serviceAreasService'
      | 'authClient'
      | 'stockQueries'
      | 'storageService'
      | 'gateEntries'
    >,
  ) {}

  /**
   * After login: profile, the warehouses the user may open (with their permissions there), the
   * default one, and the enabled modules. An empty `warehouses` list = "no warehouse access yet".
   */
  async me(caller: Caller, roles: readonly string[]) {
    const { warehousesService, authClient } = this.deps;
    const [rows, contacts] = await Promise.all([
      warehousesService.visible(caller.access.scope('warehouse.view')),
      authClient.contacts([caller.userId]),
    ]);
    const contact = contacts.get(caller.userId);
    const warehouses = rows
      .sort((a, b) =>
        a.type === b.type ? a.code.localeCompare(b.code) : a.type === 'MOTHER' ? -1 : 1,
      )
      .map((w) => ({
        id: w.id,
        code: w.code,
        name: w.name,
        type: w.type,
        status: w.status,
        city: w.city,
        stateName: stateName(w.stateCode),
        permissions: caller.access.keysAt(w.id),
      }));
    const live = warehouses.filter((w) => w.status === 'ACTIVE' || w.status === 'LIMITED');
    const fullName = contact?.fullName ?? null;
    return {
      user: {
        id: caller.userId,
        fullName,
        email: contact?.email ?? null,
        initials:
          fullName
            ?.split(/\s+/)
            .filter((p) => p !== '')
            .slice(0, 2)
            .map((p) => p.charAt(0).toUpperCase())
            .join('') ?? null,
        roles,
      },
      canSeeAll: caller.access.isGlobal('warehouse.view'),
      warehouses,
      defaultWarehouseId: (live[0] ?? warehouses[0])?.id ?? null,
      modules: MODULES,
    };
  }

  /**
   * Header search ("Search SKU, batch or product"): warehouses by code, name or city; a 6-digit
   * query also lists who serves that PIN; bins by code; stock hits (SKU, batch, unit QR, CN / RT,
   * restock RST, transfer TR). Orders, shipments, vehicles and trips join with D-57b.
   */
  async search(caller: Caller, q: string): Promise<SearchResult[]> {
    const { warehousesService, serviceAreasService, stockQueries, storageService } = this.deps;
    const scope = caller.access.scope('warehouse.view');
    const [warehouses, coverage, bins, stock, gate] = await Promise.all([
      warehousesService.search(q, scope, 10),
      PIN.test(q) ? serviceAreasService.coverage(caller, q) : Promise.resolve([]),
      q.length >= 2 ? storageService.binsByCode(scope, q, 5) : Promise.resolve([]),
      q.length >= 2 ? stockQueries.search(caller, q) : Promise.resolve([]),
      // D-62: inbound shipments, vehicles at the gate, gate passes.
      this.deps.gateEntries.search(caller, q),
    ]);
    return [
      ...warehouses.map((w) => ({
        type: 'warehouse' as const,
        id: w.id,
        title: `${w.name} (${w.code})`,
        subtitle: `${w.city}, ${stateName(w.stateCode) ?? w.stateCode} · ${w.status}`,
        warehouseId: w.id,
      })),
      ...coverage.map((c) => ({
        type: 'pin' as const,
        id: `${q}:${c.warehouseId}`,
        title: `PIN ${q} → ${c.name} (${c.code})`,
        subtitle: `Rank ${String(c.priorityRank)}${c.routable ? '' : ' · not routable now'}`,
        warehouseId: c.warehouseId,
      })),
      ...bins.map((b) => ({
        type: 'bin' as const,
        id: b.id,
        title: `Bin ${b.code}`,
        subtitle: warehouses.find((w) => w.id === b.warehouseId)?.code ?? 'Bin',
        warehouseId: b.warehouseId,
      })),
      ...stock.map((h) => ({ ...h, type: h.type as SearchResult['type'] })),
      ...gate,
    ];
  }
}
