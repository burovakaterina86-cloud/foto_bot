-- CreateTable
CREATE TABLE "InviteCode" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "usedBy" TEXT,
    "usedAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventType" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Question" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "checklistId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "taskType" TEXT NOT NULL DEFAULT 'photo',
    "section" TEXT,
    "aiRule" TEXT,
    CONSTRAINT "Question_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "Checklist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Question" ("aiRule", "checklistId", "id", "isRequired", "order", "text") SELECT "aiRule", "checklistId", "id", "isRequired", "order", "text" FROM "Question";
DROP TABLE "Question";
ALTER TABLE "new_Question" RENAME TO "Question";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_idempotencyKey_key" ON "Outbox"("idempotencyKey");
