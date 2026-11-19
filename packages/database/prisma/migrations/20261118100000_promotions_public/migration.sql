-- order-service Phase 1: public offers page. A promotion is listed on GET /v1/orders/offers/public
-- (no login) only when an admin sets isPublic (private / targeted codes never leak).

-- AlterTable
ALTER TABLE "promotions" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;
