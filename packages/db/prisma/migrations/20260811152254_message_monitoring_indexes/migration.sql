-- CreateIndex
CREATE INDEX "Notification_relatedMessageId_idx" ON "Notification"("relatedMessageId");

-- CreateIndex
CREATE INDEX "OutboundMessage_relatedMessageId_idx" ON "OutboundMessage"("relatedMessageId");
