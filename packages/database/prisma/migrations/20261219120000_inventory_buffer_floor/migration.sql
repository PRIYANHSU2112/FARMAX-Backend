-- D-57b W3.13 ATP guardrail: the storefront hides a node's stock at or below
-- reorderLevel × bufferFloorPct / 100 ("Throttled"). 0 = off (previous behaviour).
INSERT INTO "inventory_settings" ("key", "value") VALUES ('bufferFloorPct', '0')
ON CONFLICT ("key") DO NOTHING;
