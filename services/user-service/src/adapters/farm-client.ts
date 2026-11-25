import type { UserConfig } from '../config/index.js';
import { getJson } from './http.js';

/** What home needs from the farmer's farm (farm-service owns it; read with the caller's token). */
export interface FarmContext {
  farmId: string;
  farmName: string;
  /** POULTRY_FARM | HATCHERY | FEED_MILL | BACKYARD */
  category: string;
  /** LAYER, BROILER, … (home `farmTypes` targeting). */
  productionTypes: string[];
  totalBirdCapacity: number | null;
  /** Territory code, e.g. `WG` (home `regions` targeting). */
  territoryCode: string | null;
  /** The depot (inventory node) that serves this farm: "in stock at my depot". */
  primaryNodeId: string | null;
}

interface FarmSummary {
  id: string;
  name: string;
  category: string;
  productionTypes: string[];
  totalBirdCapacity: number | null;
  createdAt: string;
}

interface FarmDetail {
  location: { territoryCode: string | null; primaryNodeId: string | null } | null;
}

/** Farms a customer may own; more than this is not a real farmer. */
const MAX_FARMS = 50;
const NEWS_FETCH_LIMIT = 10;

/**
 * farm-service CUSTOMER routes, called with the caller's own bearer token (farm-service checks
 * ownership itself). No caching here; the home feature caches the result.
 */
export class FarmClient {
  constructor(private readonly deps: { config: UserConfig }) {}

  private url(path: string): string {
    return `${this.deps.config.FARM_SERVICE_URL}${path}`;
  }

  /**
   * The farm that decides region + depot: `preferredFarmId` when it is one of the caller's ACTIVE
   * farms, otherwise the oldest ACTIVE farm. null = no active farm. Both calls share one budget.
   */
  async context(
    bearer: string,
    preferredFarmId: string | undefined,
    timeoutMs: number,
  ): Promise<FarmContext | null> {
    const signal = AbortSignal.timeout(timeoutMs);
    const list = await getJson<{ data?: FarmSummary[] }>(
      this.url(`/farms?status=ACTIVE&limit=${String(MAX_FARMS)}`),
      { bearer, timeoutMs, signal },
    );
    const farms = list.data ?? [];
    const farm =
      farms.find((f) => f.id === preferredFarmId) ??
      [...farms].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (farm === undefined) return null;

    const detail = await getJson<{ data?: FarmDetail }>(
      this.url(`/farms/${encodeURIComponent(farm.id)}`),
      { bearer, timeoutMs, signal },
    );
    const location = detail.data?.location ?? null;
    return {
      farmId: farm.id,
      farmName: farm.name,
      category: farm.category,
      productionTypes: farm.productionTypes,
      totalBirdCapacity: farm.totalBirdCapacity,
      territoryCode: location?.territoryCode ?? null,
      primaryNodeId: location?.primaryNodeId ?? null,
    };
  }

  /** Newest content cards for the caller (featured first), passed through unchanged. */
  async latestNews(bearer: string, limit: number, timeoutMs: number): Promise<unknown[]> {
    const body = await getJson<{ data?: { featured?: unknown[]; items?: unknown[] } }>(
      this.url(`/farms/content/feed?sort=latest&limit=${String(NEWS_FETCH_LIMIT)}`),
      { bearer, timeoutMs },
    );
    return [...(body.data?.featured ?? []), ...(body.data?.items ?? [])].slice(0, limit);
  }
}
