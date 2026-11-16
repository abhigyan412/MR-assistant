-- CreateEnum
CREATE TYPE "Role" AS ENUM ('MR', 'ABM', 'RBM', 'ADMIN');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('ACTIVE', 'PENDING_APPROVAL', 'REJECTED');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WEB_TEXT', 'WEB_VOICE', 'WHATSAPP', 'ADMIN');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'NEEDS_REVIEW', 'FAILED', 'DISCARDED');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Territory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "Territory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL,
    "territoryId" TEXT,
    "managerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doctor" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "externalCode" TEXT,
    "name" TEXT NOT NULL,
    "specialty" TEXT,
    "clinic" TEXT,
    "area" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chemist" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "externalCode" TEXT,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "Chemist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "composition" TEXT,
    "baseUnit" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductUnit" (
    "productId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "toBase" INTEGER NOT NULL,

    CONSTRAINT "ProductUnit_pkey" PRIMARY KEY ("productId","unit")
);

-- CreateTable
CREATE TABLE "Alias" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" TEXT,
    "alias" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "mrId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "transcript" TEXT,
    "audioKey" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorReason" TEXT,
    "extraction" JSONB,
    "rawModelOutput" JSONB,
    "adverseEventFlag" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "promptVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT,
    "rawMention" TEXT,
    "candidates" JSONB,
    "assignee" TEXT NOT NULL,
    "detail" TEXT,
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" JSONB,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "mrId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "occurredOn" TEXT NOT NULL,
    "visitEventId" TEXT,
    "doctorId" TEXT,
    "productId" TEXT,
    "chemistId" TEXT,
    "managerId" TEXT,
    "stockDelta" INTEGER,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reversesEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Territory_companyId_code_key" ON "Territory"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "User_companyId_code_key" ON "User"("companyId", "code");

-- CreateIndex
CREATE INDEX "Doctor_companyId_territoryId_status_idx" ON "Doctor"("companyId", "territoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Doctor_companyId_externalCode_key" ON "Doctor"("companyId", "externalCode");

-- CreateIndex
CREATE UNIQUE INDEX "Chemist_companyId_externalCode_key" ON "Chemist"("companyId", "externalCode");

-- CreateIndex
CREATE UNIQUE INDEX "Product_companyId_code_key" ON "Product"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Alias_companyId_entityType_userId_alias_key" ON "Alias"("companyId", "entityType", "userId", "alias");

-- CreateIndex
CREATE INDEX "Message_companyId_mrId_recordedAt_idx" ON "Message"("companyId", "mrId", "recordedAt");

-- CreateIndex
CREATE INDEX "Message_companyId_status_idx" ON "Message"("companyId", "status");

-- CreateIndex
CREATE INDEX "ReviewItem_companyId_assignee_status_idx" ON "ReviewItem"("companyId", "assignee", "status");

-- CreateIndex
CREATE INDEX "ReviewItem_messageId_idx" ON "ReviewItem"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_reversesEventId_key" ON "Event"("reversesEventId");

-- CreateIndex
CREATE INDEX "Event_companyId_mrId_occurredOn_idx" ON "Event"("companyId", "mrId", "occurredOn");

-- CreateIndex
CREATE INDEX "Event_doctorId_occurredAt_idx" ON "Event"("doctorId", "occurredAt");

-- CreateIndex
CREATE INDEX "Event_mrId_productId_idx" ON "Event"("mrId", "productId");

-- CreateIndex
CREATE INDEX "Event_messageId_idx" ON "Event"("messageId");

-- AddForeignKey
ALTER TABLE "Territory" ADD CONSTRAINT "Territory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Territory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chemist" ADD CONSTRAINT "Chemist_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_visitEventId_fkey" FOREIGN KEY ("visitEventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_reversesEventId_fkey" FOREIGN KEY ("reversesEventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
