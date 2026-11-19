-- catalog-service: categories (adjacency list + materialized path, D-28) and catalog_audit_log
-- (implementation-plan/08-catalog-service.md)

-- CreateTable
CREATE TABLE "catalog_audit_log" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "targetType" VARCHAR(30) NOT NULL,
    "targetId" VARCHAR(64) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(500),
    "ip" VARCHAR(45),
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "parentId" UUID,
    "path" TEXT NOT NULL,
    "depth" SMALLINT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "nameTe" VARCHAR(120),
    "slug" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "imageUrl" VARCHAR(500),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_audit_log_targetType_targetId_createdAt_idx" ON "catalog_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "catalog_audit_log_actorUserId_createdAt_idx" ON "catalog_audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "categories_parentId_sortOrder_idx" ON "categories"("parentId", "sortOrder");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Raw SQL: tree integrity and fast subtree reads (not expressible in Prisma) ──

-- Subtree / descendants: `WHERE path LIKE '<prefix>%'` becomes an index range scan.
CREATE INDEX "categories_path_idx" ON "categories" ("path" text_pattern_ops) WHERE "deletedAt" IS NULL;

-- Slug is the public URL key: unique among live categories (a deleted slug can be reused).
CREATE UNIQUE INDEX "categories_slug_live_key" ON "categories" ("slug") WHERE "deletedAt" IS NULL;

-- No two live siblings with the same name (case-insensitive); roots share the nil parent.
CREATE UNIQUE INDEX "categories_sibling_name_live_key" ON "categories"
  (COALESCE("parentId", '00000000-0000-0000-0000-000000000000'::uuid), lower("name"))
  WHERE "deletedAt" IS NULL;

ALTER TABLE "categories" ADD CONSTRAINT "categories_depth_non_negative" CHECK ("depth" >= 0);
ALTER TABLE "categories" ADD CONSTRAINT "categories_path_ends_with_id" CHECK ("path" LIKE '%/' || "id"::text || '/');
ALTER TABLE "categories" ADD CONSTRAINT "categories_root_depth" CHECK (("parentId" IS NULL) = ("depth" = 0));
ALTER TABLE "categories" ADD CONSTRAINT "categories_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id");

-- Append-only audit (D-15 function from the init migration).
CREATE TRIGGER "catalog_audit_log_append_only" BEFORE UPDATE OR DELETE ON "catalog_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "catalog_audit_log_no_truncate" BEFORE TRUNCATE ON "catalog_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
