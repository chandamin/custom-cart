-- CreateTable
CREATE TABLE "GeneratedVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "mainVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedVariant_variantId_key" ON "GeneratedVariant"("variantId");

-- CreateIndex
CREATE INDEX "GeneratedVariant_shop_variantId_idx" ON "GeneratedVariant"("shop", "variantId");
