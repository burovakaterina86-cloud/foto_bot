-- AlterTable
ALTER TABLE "Question" ADD COLUMN "referencePhoto" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "location" TEXT;
ALTER TABLE "User" ADD COLUMN "shiftStartedAt" DATETIME;
