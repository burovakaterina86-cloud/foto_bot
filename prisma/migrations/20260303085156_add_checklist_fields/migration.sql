/*
  Warnings:

  - Added the required column `role` to the `Checklist` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `Checklist` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Question" ADD COLUMN "aiRule" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Checklist" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "role" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timeWindows" TEXT,
    "intervalHours" INTEGER
);
INSERT INTO "new_Checklist" ("description", "id", "key", "title") SELECT "description", "id", "key", "title" FROM "Checklist";
DROP TABLE "Checklist";
ALTER TABLE "new_Checklist" RENAME TO "Checklist";
CREATE UNIQUE INDEX "Checklist_key_key" ON "Checklist"("key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
