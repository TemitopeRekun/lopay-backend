/*
  Warnings:

  - You are about to drop the column `proofOfPaymentUrl` on the `Payment` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "proofOfPaymentUrl",
ADD COLUMN     "receiptUrl" TEXT;
