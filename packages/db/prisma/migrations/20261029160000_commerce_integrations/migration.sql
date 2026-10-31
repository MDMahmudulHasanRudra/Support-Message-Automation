-- Commerce integrations (COMMERCE_INTEGRATIONS.md): courier connections and shipments, shop
-- connections and their sync runs. Additive: five new project-owned tables, three enums, one new
-- nullable column (ProductVariant.externalId) and partial unique indexes for imported rows.

-- CreateEnum
CREATE TYPE "CourierProvider" AS ENUM ('STEADFAST', 'PATHAO', 'REDX');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('BOOKING', 'BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'ON_HOLD', 'DELIVERED', 'PARTIAL_DELIVERED', 'RETURNED', 'CANCELLED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ShopProvider" AS ENUM ('WOOCOMMERCE', 'SHOPIFY');

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "externalId" TEXT;

-- CreateTable
CREATE TABLE "CourierConnection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "provider" "CourierProvider" NOT NULL,
    "label" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "credentialsCiphertext" TEXT NOT NULL,
    "settings" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckOk" BOOLEAN,
    "lastError" TEXT,
    "createdByUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "orderId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" "CourierProvider" NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'BOOKING',
    "providerStatus" TEXT,
    "invoice" TEXT NOT NULL,
    "consignmentId" TEXT,
    "trackingCode" TEXT,
    "codAmountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "note" TEXT,
    "details" JSONB,
    "error" TEXT,
    "bookedByUsername" TEXT NOT NULL,
    "bookedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "shipmentId" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "providerStatus" TEXT,
    "note" TEXT,
    "actorUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopConnection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "provider" "ShopProvider" NOT NULL,
    "label" TEXT NOT NULL,
    "shopUrl" TEXT NOT NULL,
    "credentialsCiphertext" TEXT NOT NULL,
    "webhookSecretCiphertext" TEXT,
    "webhookKey" TEXT NOT NULL,
    "currency" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "importOrders" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncOk" BOOLEAN,
    "lastError" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "createdByUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSyncRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "orderId" TEXT,
    "externalId" TEXT,
    "status" TEXT NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "actorUsername" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ShopSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourierConnection_projectId_provider_key" ON "CourierConnection"("projectId", "provider");

-- CreateIndex
CREATE INDEX "Shipment_projectId_status_lastCheckedAt_idx" ON "Shipment"("projectId", "status", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "Shipment_orderId_idx" ON "Shipment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_projectId_invoice_key" ON "Shipment"("projectId", "invoice");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shipmentId_createdAt_idx" ON "ShipmentEvent"("shipmentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopConnection_webhookKey_key" ON "ShopConnection"("webhookKey");

-- CreateIndex
CREATE UNIQUE INDEX "ShopConnection_projectId_provider_key" ON "ShopConnection"("projectId", "provider");

-- CreateIndex
CREATE INDEX "ShopSyncRun_connectionId_startedAt_idx" ON "ShopSyncRun"("connectionId", "startedAt");

-- AddForeignKey
ALTER TABLE "CourierConnection" ADD CONSTRAINT "CourierConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CourierConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopConnection" ADD CONSTRAINT "ShopConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopSyncRun" ADD CONSTRAINT "ShopSyncRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopSyncRun" ADD CONSTRAINT "ShopSyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ShopConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One import per shop record: re-importing updates the same product, variant or order.
CREATE UNIQUE INDEX "Product_projectId_external_key" ON "Product"("projectId", "externalSource", "externalId") WHERE "externalId" IS NOT NULL;
CREATE UNIQUE INDEX "ProductVariant_productId_externalId_key" ON "ProductVariant"("productId", "externalId") WHERE "externalId" IS NOT NULL;
CREATE UNIQUE INDEX "CommerceOrder_projectId_external_key" ON "CommerceOrder"("projectId", "externalSource", "externalId") WHERE "externalId" IS NOT NULL;

-- At most one live shipment per order: a second booking is refused until the first failed or was cancelled.
CREATE UNIQUE INDEX "Shipment_one_live_per_order" ON "Shipment"("orderId") WHERE "status" NOT IN ('FAILED', 'CANCELLED');
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_cod_check" CHECK ("codAmountMinor" >= 0);

-- An order is sent to a shop once: a second push waits until the first FAILED (an UNKNOWN outcome keeps the slot).
CREATE UNIQUE INDEX "ShopSyncRun_one_push_per_order" ON "ShopSyncRun"("connectionId", "orderId") WHERE "kind" = 'PUSH_ORDER' AND "status" <> 'FAILED';

-- Project integrity (MULTI_PROJECT_PLAN.md Phase 7).
CREATE TRIGGER "CourierConnection_projectId_immutable" BEFORE UPDATE OF "projectId" ON "CourierConnection" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "Shipment_projectId_immutable" BEFORE UPDATE OF "projectId" ON "Shipment" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ShipmentEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ShipmentEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ShopConnection_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ShopConnection" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ShopSyncRun_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ShopSyncRun" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "Shipment_orderId_same_project" AFTER INSERT OR UPDATE OF "orderId", "projectId" ON "Shipment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('CommerceOrder', 'orderId');
CREATE CONSTRAINT TRIGGER "Shipment_connectionId_same_project" AFTER INSERT OR UPDATE OF "connectionId", "projectId" ON "Shipment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('CourierConnection', 'connectionId');
CREATE CONSTRAINT TRIGGER "ShipmentEvent_shipmentId_same_project" AFTER INSERT OR UPDATE OF "shipmentId", "projectId" ON "ShipmentEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Shipment', 'shipmentId');
CREATE CONSTRAINT TRIGGER "ShopSyncRun_connectionId_same_project" AFTER INSERT OR UPDATE OF "connectionId", "projectId" ON "ShopSyncRun" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ShopConnection', 'connectionId');

-- The shipment history is append-only, like the order's.
CREATE TRIGGER "ShipmentEvent_append_only" BEFORE UPDATE ON "ShipmentEvent" FOR EACH ROW EXECUTE FUNCTION commerce_audit_append_only();
