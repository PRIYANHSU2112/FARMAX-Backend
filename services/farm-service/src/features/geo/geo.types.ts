import type { CursorQuery } from '@farmx/common/types';

export interface PinView {
  pinCode: string;
  serviceable: boolean;
  territory: { id: string; code: string };
  districtName: string;
  mandalName: string | null;
  villages: string[];
  primaryNode: { id: string; name: string | null } | null;
  backupNode: { id: string; name: string | null } | null;
  deliveryPromise: string | null;
}

export interface TerritoryView {
  id: string;
  code: string;
  name: string;
  districtName: string;
  stateCode: string;
  isActive: boolean;
}

export interface TerritoryInput {
  code: string;
  name: string;
  districtName: string;
  stateCode: string;
  isActive?: boolean;
}

export interface PinInput {
  territoryCode: string;
  districtName: string;
  mandalName?: string | null;
  villages?: string[];
  primaryNodeId?: string | null;
  primaryNodeName?: string | null;
  backupNodeId?: string | null;
  backupNodeName?: string | null;
  deliveryPromise?: string | null;
  serviceable?: boolean;
  reason: string;
}

export interface PinListQuery extends CursorQuery {
  territoryCode?: string;
}
