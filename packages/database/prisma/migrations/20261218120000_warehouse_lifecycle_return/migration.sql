-- D-57b Phase 4b: a failed delivery comes back to the warehouse (W4.11 lifecycle row).
INSERT INTO "warehouse_status_transitions"
  ("fromStatus", "toStatus", "requiredEvent", "roleLabel", "permissionKey", "systemOnly", "sortOrder", "updatedAt") VALUES
  ('DISPATCHED', 'RETURNED', 'Failed delivery returned to the warehouse', 'Returns team', 'inventory.receive', false, 135, now())
ON CONFLICT DO NOTHING;
