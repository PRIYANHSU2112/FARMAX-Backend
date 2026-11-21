-- "In stock at <node>" (storefront filter & sort sheet): per-node availability projection
-- fed by inventory.availability_changed.v1 `byNode`, plus the shelf-life sort index.

-- CreateTable
CREATE TABLE "variant_node_availability" (
    "variantId" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "availableQty" INTEGER NOT NULL,
    "inStock" BOOLEAN NOT NULL,
    "sourceVersion" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_node_availability_pkey" PRIMARY KEY ("variantId","nodeId")
);

-- CreateIndex
CREATE INDEX "variant_node_availability_nodeId_inStock_variantId_idx" ON "variant_node_availability"("nodeId", "inStock", "variantId");

-- CreateIndex
CREATE INDEX "products_shelfLifeMonths_idx" ON "products"("shelfLifeMonths");

-- AddForeignKey
ALTER TABLE "variant_node_availability" ADD CONSTRAINT "variant_node_availability_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
