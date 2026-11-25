-- D-57a §6a: Packed → Dispatched is passed by the dispatch checks (Figma W4.11 text).
UPDATE "warehouse_status_transitions"
  SET "requiredEvent" = 'Dispatch checks passed', "updatedAt" = now()
  WHERE "fromStatus" = 'PACKED' AND "toStatus" = 'DISPATCHED';
