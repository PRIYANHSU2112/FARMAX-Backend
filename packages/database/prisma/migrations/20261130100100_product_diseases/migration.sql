-- CreateTable
CREATE TABLE "diseases" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "iconUrl" VARCHAR(500),
    "iconMediaId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "diseases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_diseases" (
    "productId" UUID NOT NULL,
    "diseaseId" UUID NOT NULL,

    CONSTRAINT "product_diseases_pkey" PRIMARY KEY ("productId","diseaseId")
);

-- CreateIndex
CREATE INDEX "diseases_isActive_sortOrder_idx" ON "diseases"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "product_diseases_diseaseId_idx" ON "product_diseases"("diseaseId");

-- AddForeignKey
ALTER TABLE "product_diseases" ADD CONSTRAINT "product_diseases_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_diseases" ADD CONSTRAINT "product_diseases_diseaseId_fkey" FOREIGN KEY ("diseaseId") REFERENCES "diseases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Slug / name unique among LIVE diseases only: a soft-deleted disease keeps its row (history) and
-- its slug can be reused by a new disease.
CREATE UNIQUE INDEX "diseases_slug_live_key" ON "diseases" ("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "diseases_name_live_key" ON "diseases" (lower("name")) WHERE "deletedAt" IS NULL;
ALTER TABLE "diseases" ADD CONSTRAINT "diseases_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- Flock-stage filter: productionStages && ARRAY[...] uses this.
CREATE INDEX "products_production_stages_idx" ON "products" USING GIN ("productionStages");

-- Seed FLOCK_STAGE master values (admins add / rename / deactivate). meta.aliases = legacy free-text
-- values the stages:map script maps to the code.
INSERT INTO "product_lookups" ("id", "group", "code", "label", "meta", "sortOrder", "createdByUserId", "updatedByUserId", "updatedAt")
SELECT gen_random_uuid(), 'FLOCK_STAGE'::"ProductLookupGroup", v."code", v."label", v."meta"::jsonb, v."sortOrder",
       '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, CURRENT_TIMESTAMP
FROM (VALUES
  ('CHICK', 'Chick (day-old)', '{"aliases": ["chick", "chicks", "day old", "day old chick", "doc"]}', 10),
  ('BROODER', 'Brooder / starter', '{"aliases": ["brooder", "brooding", "starter", "pre starter"]}', 20),
  ('GROWER', 'Grower', '{"aliases": ["grower", "growing", "growers"]}', 30),
  ('FINISHER', 'Finisher', '{"aliases": ["finisher", "finishing"]}', 40),
  ('PRE_LAYER', 'Pre-layer', '{"aliases": ["pre layer", "prelayer", "prelay", "pullet"]}', 50),
  ('LAYER', 'Layer (in lay)', '{"aliases": ["layer", "layers", "laying", "in lay", "egg"]}', 60),
  ('BREEDER', 'Breeder / parent stock', '{"aliases": ["breeder", "breeders", "parent", "parent stock"]}', 70)
) AS v("code", "label", "meta", "sortOrder")
WHERE NOT EXISTS (
  SELECT 1 FROM "product_lookups" l
  WHERE l."group" = 'FLOCK_STAGE' AND l."code" = v."code" AND l."deletedAt" IS NULL
);
