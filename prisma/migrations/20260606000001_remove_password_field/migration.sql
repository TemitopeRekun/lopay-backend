-- AlterTable: remove the meaningless password placeholder column
-- Passwords are managed entirely by Firebase Auth; this column was never used.
ALTER TABLE "User" DROP COLUMN "password";
