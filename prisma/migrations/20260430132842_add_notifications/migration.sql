-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'CALL', 'EMAIL', 'WHATSAPP', 'WEBHOOK');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "providerStatus" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_checkId_idx" ON "Notification"("checkId");

-- CreateIndex
CREATE INDEX "Notification_monitorId_createdAt_idx" ON "Notification"("monitorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
