-- Commerce-aware AI (AI_COMMERCE.md): five project AI settings. Additive; every existing project keeps
-- answering exactly as before (all off except the hand-over of order requests, which only applies when
-- a commerce answer is switched on).
ALTER TABLE "AiSettings"
  ADD COLUMN "commerceProductAnswers" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "commerceOrderAnswers" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "commerceDeliveryAnswers" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "commerceShowStockCount" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "commerceHandoverRequests" BOOLEAN NOT NULL DEFAULT true;
