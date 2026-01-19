/*
  Warnings:

  - The values [ADMIN,SCHOOL] on the enum `UserRole` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `balance` on the `Child` table. All the data in the column will be lost.
  - You are about to drop the column `class` on the `Child` table. All the data in the column will be lost.
  - You are about to drop the column `schoolId` on the `Child` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Child` table. All the data in the column will be lost.
  - You are about to drop the column `totalFee` on the `Child` table. All the data in the column will be lost.
  - You are about to drop the column `amount` on the `Payment` table. All the data in the column will be lost.
  - You are about to drop the column `childId` on the `Payment` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `Payment` table. All the data in the column will be lost.
  - You are about to drop the column `proofUrl` on the `Payment` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Payment` table. All the data in the column will be lost.
  - You are about to drop the column `schoolId` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[ownerId]` on the table `School` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `className` to the `Child` table without a default value. This is not possible if the table is not empty.
  - Added the required column `amountPaid` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `enrollmentId` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `paymentType` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platformAmount` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolAmount` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolId` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `accountName` to the `School` table without a default value. This is not possible if the table is not empty.
  - Added the required column `ownerId` to the `School` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('FIRST_PAYMENT', 'INSTALLMENT');

-- CreateEnum
CREATE TYPE "InstallmentFrequency" AS ENUM ('WEEKLY', 'MONTHLY');

-- AlterEnum
BEGIN;
CREATE TYPE "UserRole_new" AS ENUM ('SUPER_ADMIN', 'SCHOOL_OWNER', 'PARENT');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole_new" USING ("role"::text::"UserRole_new");
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "public"."UserRole_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Child" DROP CONSTRAINT "Child_parentId_fkey";

-- DropForeignKey
ALTER TABLE "Child" DROP CONSTRAINT "Child_schoolId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_childId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_schoolId_fkey";

-- DropIndex
DROP INDEX "School_name_key";

-- DropIndex
DROP INDEX "User_schoolId_key";

-- AlterTable
ALTER TABLE "Child" DROP COLUMN "balance",
DROP COLUMN "class",
DROP COLUMN "schoolId",
DROP COLUMN "status",
DROP COLUMN "totalFee",
ADD COLUMN     "className" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "amount",
DROP COLUMN "childId",
DROP COLUMN "createdAt",
DROP COLUMN "proofUrl",
DROP COLUMN "status",
ADD COLUMN     "amountPaid" INTEGER NOT NULL,
ADD COLUMN     "enrollmentId" TEXT NOT NULL,
ADD COLUMN     "paymentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "paymentType" "PaymentType" NOT NULL,
ADD COLUMN     "platformAmount" INTEGER NOT NULL,
ADD COLUMN     "schoolAmount" INTEGER NOT NULL,
ADD COLUMN     "schoolId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "accountName" TEXT NOT NULL,
ADD COLUMN     "ownerId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "schoolId";

-- CreateTable
CREATE TABLE "ClassFee" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "feeAmount" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassFee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Parent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Parent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildEnrollment" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "totalSchoolFee" INTEGER NOT NULL,
    "platformFee" INTEGER NOT NULL,
    "schoolMinimumFee" INTEGER NOT NULL,
    "firstPaymentPaid" INTEGER NOT NULL,
    "remainingBalance" INTEGER NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL,
    "installmentFrequency" "InstallmentFrequency" NOT NULL,
    "termStartDate" TIMESTAMP(3) NOT NULL,
    "termEndDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChildEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClassFee_schoolId_className_key" ON "ClassFee"("schoolId", "className");

-- CreateIndex
CREATE UNIQUE INDEX "Parent_userId_key" ON "Parent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChildEnrollment_childId_key" ON "ChildEnrollment"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSetting_key_key" ON "PlatformSetting"("key");

-- CreateIndex
CREATE UNIQUE INDEX "School_ownerId_key" ON "School"("ownerId");

-- AddForeignKey
ALTER TABLE "School" ADD CONSTRAINT "School_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassFee" ADD CONSTRAINT "ClassFee_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Parent" ADD CONSTRAINT "Parent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Child" ADD CONSTRAINT "Child_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Parent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "ChildEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildEnrollment" ADD CONSTRAINT "ChildEnrollment_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildEnrollment" ADD CONSTRAINT "ChildEnrollment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
