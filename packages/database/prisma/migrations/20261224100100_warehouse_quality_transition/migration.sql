-- D-60: a receipt of a quality-blocked (quarantined / recalled) batch lands straight in QUARANTINED.
INSERT INTO "warehouse_status_transitions"
  ("fromStatus", "toStatus", "requiredEvent", "roleLabel", "permissionKey", "systemOnly", "sortOrder", "updatedAt")
VALUES
  ('RECEIVED', 'QUARANTINED', 'Receipt of a quality-blocked batch (D-60)', 'System', NULL, true, 155, now())
ON CONFLICT ("fromStatus", "toStatus") DO NOTHING;
