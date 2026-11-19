-- Outbox relay (Phase 2): the relay polls only unpublished rows, oldest first.
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" ("createdAt", "id") WHERE "publishedAt" IS NULL;
