export type AuditTarget =
  | 'warehouse'
  | 'service_area'
  | 'zone'
  | 'rack'
  | 'bin'
  | 'dock_door'
  | 'dock_booking'
  | 'staging_area'
  | 'yard_slot'
  | 'calendar'
  | 'shift'
  | 'holiday'
  | 'storage_rule'
  | 'staff'
  // D-57 stock
  | 'stock_receipt'
  | 'stock_batch'
  | 'stock_position'
  | 'stock_adjustment'
  | 'stock_lifecycle'
  | 'stock_threshold'
  | 'stock_settings'
  | 'stock_cutover'
  | 'vendor'
  | 'restock_request'
  | 'transfer'
  // D-57b fulfilment
  | 'order'
  | 'hold'
  | 'shipment'
  | 'task'
  | 'exception'
  | 'reallocation'
  | 'shelf_life_rule'
  | 'fulfilment_settings'
  | 'compliance_case'
  // D-57b dispatch
  | 'trip'
  // D-57b routing / planning
  | 'routing_rule'
  | 'routing_settings'
  | 'routing_throttle'
  | 'backorder'
  | 'atp_settings';

export interface AuditEntry {
  action: string;
  targetType: AuditTarget;
  targetId: string;
  before?: object | null;
  after?: object | null;
  reason?: string | null;
}

/** Who did it, from where. `userId` null = a system actor (event consumer, job). */
export interface Actor {
  userId: string | null;
  ip: string | null;
  requestId: string | null;
}
