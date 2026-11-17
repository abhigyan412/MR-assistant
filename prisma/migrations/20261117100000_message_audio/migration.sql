-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "audioDurationMs" INTEGER,
ADD COLUMN     "audioMime" TEXT,
ADD COLUMN     "audioSegments" INTEGER,
ADD COLUMN     "sttModel" TEXT;

