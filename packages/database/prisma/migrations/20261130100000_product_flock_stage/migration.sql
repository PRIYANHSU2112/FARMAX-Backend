-- New dynamic lookup group for flock / production stages (own migration: a new enum value must be
-- committed before rows can use it).
ALTER TYPE "ProductLookupGroup" ADD VALUE IF NOT EXISTS 'FLOCK_STAGE';
