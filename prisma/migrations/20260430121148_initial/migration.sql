-- CreateEnum
CREATE TYPE "KeywordMode" AS ENUM ('PRESENT', 'MISSING');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('PASSING', 'FAILING', 'ERROR');

-- CreateTable
CREATE TABLE "Monitor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "intervalSec" INTEGER NOT NULL DEFAULT 60,
    "cookies" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Monitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "mode" "KeywordMode" NOT NULL DEFAULT 'PRESENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Check" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "status" "CheckStatus" NOT NULL,
    "httpStatus" INTEGER,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordResult" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL,

    CONSTRAINT "KeywordResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Keyword_monitorId_idx" ON "Keyword"("monitorId");

-- CreateIndex
CREATE INDEX "Check_monitorId_checkedAt_idx" ON "Check"("monitorId", "checkedAt");

-- CreateIndex
CREATE INDEX "KeywordResult_checkId_idx" ON "KeywordResult"("checkId");

-- CreateIndex
CREATE INDEX "KeywordResult_keywordId_idx" ON "KeywordResult"("keywordId");

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordResult" ADD CONSTRAINT "KeywordResult_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordResult" ADD CONSTRAINT "KeywordResult_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;
