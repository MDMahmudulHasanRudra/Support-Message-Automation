-- Commerce core (COMMERCE.md): catalogue and stock, orders, sales pipeline. Additive: nine new
-- project-owned tables, four enums and one sequence. Nothing existing changes.

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'DRAFT', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CommerceOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "CommercePaymentStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SalesLeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST');

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sku" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency" TEXT NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "compareAtMinor" BIGINT,
    "trackInventory" BOOLEAN NOT NULL DEFAULT true,
    "stockQuantity" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "externalSource" TEXT,
    "externalId" TEXT,
    "createdByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "priceMinor" BIGINT,
    "stockQuantity" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "orderId" TEXT,
    "note" TEXT,
    "balanceAfter" INTEGER NOT NULL,
    "actorUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "number" TEXT NOT NULL,
    "clientId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "shippingAddress" TEXT,
    "channel" TEXT,
    "status" "CommerceOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentStatus" "CommercePaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "currency" TEXT NOT NULL,
    "subtotalMinor" BIGINT NOT NULL,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "shippingMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL,
    "paidMinor" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "externalSource" TEXT,
    "externalId" TEXT,
    "createdByUsername" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrderItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,

    CONSTRAINT "CommerceOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrderEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" "CommerceOrderStatus",
    "toStatus" "CommerceOrderStatus",
    "detail" JSONB,
    "actorUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesLead" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "company" TEXT,
    "source" TEXT NOT NULL DEFAULT 'OTHER',
    "stage" "SalesLeadStage" NOT NULL DEFAULT 'NEW',
    "currency" TEXT,
    "valueMinor" BIGINT,
    "assignedUserId" TEXT,
    "nextFollowUpAt" TIMESTAMP(3),
    "notes" TEXT,
    "lostReason" TEXT,
    "wonOrderId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdByUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesLeadEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStage" "SalesLeadStage",
    "toStage" "SalesLeadStage",
    "note" TEXT,
    "actorUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesLeadEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_projectId_name_key" ON "ProductCategory"("projectId", "name");

-- CreateIndex
CREATE INDEX "Product_projectId_status_idx" ON "Product"("projectId", "status");

-- CreateIndex
CREATE INDEX "Product_projectId_name_idx" ON "Product"("projectId", "name");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE INDEX "InventoryMovement_productId_createdAt_idx" ON "InventoryMovement"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_projectId_status_createdAt_idx" ON "CommerceOrder"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_clientId_idx" ON "CommerceOrder"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceOrder_projectId_number_key" ON "CommerceOrder"("projectId", "number");

-- CreateIndex
CREATE INDEX "CommerceOrderItem_orderId_idx" ON "CommerceOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "CommerceOrderEvent_orderId_createdAt_idx" ON "CommerceOrderEvent"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "SalesLead_projectId_stage_idx" ON "SalesLead"("projectId", "stage");

-- CreateIndex
CREATE INDEX "SalesLead_projectId_nextFollowUpAt_idx" ON "SalesLead"("projectId", "nextFollowUpAt");

-- CreateIndex
CREATE INDEX "SalesLeadEvent_leadId_createdAt_idx" ON "SalesLeadEvent"("leadId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderEvent" ADD CONSTRAINT "CommerceOrderEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderEvent" ADD CONSTRAINT "CommerceOrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesLead" ADD CONSTRAINT "SalesLead_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesLead" ADD CONSTRAINT "SalesLead_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesLead" ADD CONSTRAINT "SalesLead_wonOrderId_fkey" FOREIGN KEY ("wonOrderId") REFERENCES "CommerceOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesLeadEvent" ADD CONSTRAINT "SalesLeadEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesLeadEvent" ADD CONSTRAINT "SalesLeadEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "SalesLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Order numbers (ORD-000042), one sequence for the installation like client receipts.
CREATE SEQUENCE IF NOT EXISTS "commerce_order_seq" START 1;

-- A SKU is unique within a project when given.
CREATE UNIQUE INDEX "Product_projectId_sku_key" ON "Product"("projectId", "sku") WHERE "sku" IS NOT NULL;
CREATE INDEX "Product_projectId_externalId_idx" ON "Product"("projectId", "externalSource", "externalId") WHERE "externalId" IS NOT NULL;

-- Money and stock can never go below zero.
ALTER TABLE "Product" ADD CONSTRAINT "Product_amounts_check" CHECK ("priceMinor" >= 0 AND ("compareAtMinor" IS NULL OR "compareAtMinor" >= 0) AND "stockQuantity" >= 0);
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_amounts_check" CHECK (("priceMinor" IS NULL OR "priceMinor" >= 0) AND "stockQuantity" >= 0);
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_amounts_check" CHECK ("subtotalMinor" >= 0 AND "discountMinor" >= 0 AND "shippingMinor" >= 0 AND "totalMinor" >= 0 AND "paidMinor" >= 0 AND "discountMinor" <= "subtotalMinor");
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_amounts_check" CHECK ("quantity" > 0 AND "unitPriceMinor" >= 0 AND "totalMinor" >= 0);
ALTER TABLE "SalesLead" ADD CONSTRAINT "SalesLead_value_check" CHECK ("valueMinor" IS NULL OR "valueMinor" >= 0);

-- Project integrity (MULTI_PROJECT_PLAN.md Phase 7): a row's project never changes, and a child row's
-- parent is always in the same project.
CREATE TRIGGER "ProductCategory_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ProductCategory" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "Product_projectId_immutable" BEFORE UPDATE OF "projectId" ON "Product" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ProductVariant_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ProductVariant" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "InventoryMovement_projectId_immutable" BEFORE UPDATE OF "projectId" ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "CommerceOrder_projectId_immutable" BEFORE UPDATE OF "projectId" ON "CommerceOrder" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "CommerceOrderItem_projectId_immutable" BEFORE UPDATE OF "projectId" ON "CommerceOrderItem" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "CommerceOrderEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "CommerceOrderEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SalesLead_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SalesLead" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SalesLeadEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SalesLeadEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "ProductCategory_parentId_same_project" AFTER INSERT OR UPDATE OF "parentId", "projectId" ON "ProductCategory" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ProductCategory', 'parentId');
CREATE CONSTRAINT TRIGGER "Product_categoryId_same_project" AFTER INSERT OR UPDATE OF "categoryId", "projectId" ON "Product" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ProductCategory', 'categoryId');
CREATE CONSTRAINT TRIGGER "ProductVariant_productId_same_project" AFTER INSERT OR UPDATE OF "productId", "projectId" ON "ProductVariant" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Product', 'productId');
CREATE CONSTRAINT TRIGGER "InventoryMovement_productId_same_project" AFTER INSERT OR UPDATE OF "productId", "projectId" ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Product', 'productId');
CREATE CONSTRAINT TRIGGER "InventoryMovement_variantId_same_project" AFTER INSERT OR UPDATE OF "variantId", "projectId" ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ProductVariant', 'variantId');
CREATE CONSTRAINT TRIGGER "InventoryMovement_orderId_same_project" AFTER INSERT OR UPDATE OF "orderId", "projectId" ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('CommerceOrder', 'orderId');
CREATE CONSTRAINT TRIGGER "CommerceOrder_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "CommerceOrder" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "CommerceOrderItem_orderId_same_project" AFTER INSERT OR UPDATE OF "orderId", "projectId" ON "CommerceOrderItem" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('CommerceOrder', 'orderId');
CREATE CONSTRAINT TRIGGER "CommerceOrderItem_productId_same_project" AFTER INSERT OR UPDATE OF "productId", "projectId" ON "CommerceOrderItem" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Product', 'productId');
CREATE CONSTRAINT TRIGGER "CommerceOrderItem_variantId_same_project" AFTER INSERT OR UPDATE OF "variantId", "projectId" ON "CommerceOrderItem" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ProductVariant', 'variantId');
CREATE CONSTRAINT TRIGGER "CommerceOrderEvent_orderId_same_project" AFTER INSERT OR UPDATE OF "orderId", "projectId" ON "CommerceOrderEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('CommerceOrder', 'orderId');
CREATE CONSTRAINT TRIGGER "SalesLead_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "SalesLead" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "SalesLead_wonOrderId_same_project" AFTER INSERT OR UPDATE OF "wonOrderId", "projectId" ON "SalesLead" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('CommerceOrder', 'wonOrderId');
CREATE CONSTRAINT TRIGGER "SalesLeadEvent_leadId_same_project" AFTER INSERT OR UPDATE OF "leadId", "projectId" ON "SalesLeadEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SalesLead', 'leadId');

-- The two audit trails are append-only.
CREATE OR REPLACE FUNCTION commerce_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Commerce audit rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CommerceOrderEvent_append_only" BEFORE UPDATE ON "CommerceOrderEvent" FOR EACH ROW EXECUTE FUNCTION commerce_audit_append_only();
CREATE TRIGGER "SalesLeadEvent_append_only" BEFORE UPDATE ON "SalesLeadEvent" FOR EACH ROW EXECUTE FUNCTION commerce_audit_append_only();
