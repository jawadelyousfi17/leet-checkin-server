-- AlterTable
ALTER TABLE "Monitor" ADD COLUMN     "htmlDiffEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Monitor" ADD COLUMN     "htmlDiffBaseline" TEXT;
