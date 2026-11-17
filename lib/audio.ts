import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Voice-note audio in Neon Object Storage (S3-compatible, private bucket).
// Kept for the audit trail next to the raw transcript; deleted after
// AUDIO_RETENTION_DAYS (recordings may contain patient names).
//
// Config: VOICE_S3_* (Vercel reserves the AWS_* names), falling back to the
// AWS_* names `neon env pull` writes locally. Unconfigured = audio is simply
// not stored; transcription still works.

export const AUDIO_PREFIX = "audio/";

function config() {
  const e = process.env;
  const c = {
    bucket: e.VOICE_S3_BUCKET ?? "voice-notes",
    accessKeyId: e.VOICE_S3_ACCESS_KEY_ID ?? e.AWS_ACCESS_KEY_ID,
    secretAccessKey: e.VOICE_S3_SECRET_ACCESS_KEY ?? e.AWS_SECRET_ACCESS_KEY,
    endpoint: e.VOICE_S3_ENDPOINT ?? e.AWS_ENDPOINT_URL_S3,
    region: e.VOICE_S3_REGION ?? e.AWS_REGION ?? "us-east-2",
  };
  return c.accessKeyId && c.secretAccessKey && c.endpoint ? c : null;
}

let client: { s3: S3Client; bucket: string } | null | undefined;
function storage() {
  if (client === undefined) {
    const c = config();
    client = c
      ? {
          bucket: c.bucket,
          s3: new S3Client({
            region: c.region,
            endpoint: c.endpoint,
            forcePathStyle: true, // required by Neon Object Storage
            credentials: { accessKeyId: c.accessKeyId!, secretAccessKey: c.secretAccessKey! },
          }),
        }
      : null;
  }
  return client;
}

export function audioStorageConfigured(): boolean {
  return storage() !== null;
}

/** Bare MIME type without codec parameters: "audio/webm;codecs=opus" -> "audio/webm". */
export function baseMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** File extension for the formats browsers' MediaRecorder produces (Android Chrome: webm, iOS Safari: mp4). */
export function audioExtension(mime: string): string {
  switch (baseMime(mime)) {
    case "audio/webm":
    case "video/webm":
      return "webm";
    case "audio/mp4":
    case "video/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/ogg":
      return "ogg";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    default:
      return "bin";
  }
}

export function messageAudioPrefix(messageId: string): string {
  return `${AUDIO_PREFIX}${messageId}/`;
}

export function segmentKey(messageId: string, segment: number, mime: string): string {
  return `${messageAudioPrefix(messageId)}${String(segment).padStart(2, "0")}.${audioExtension(mime)}`;
}

/** Store one recorded segment. Same key on a resend, so retries overwrite instead of duplicating. */
export async function putAudioSegment(messageId: string, segment: number, bytes: Uint8Array, mime: string): Promise<string | null> {
  const s = storage();
  if (!s) return null;
  const key = segmentKey(messageId, segment, mime);
  await s.s3.send(new PutObjectCommand({ Bucket: s.bucket, Key: key, Body: bytes, ContentType: baseMime(mime) }));
  return key;
}

/** Short-lived playback URLs for a message's segments, in order. */
export async function signedAudioUrls(messageId: string, expiresInS = 600): Promise<string[]> {
  const s = storage();
  if (!s) return [];
  const listed = await s.s3.send(new ListObjectsV2Command({ Bucket: s.bucket, Prefix: messageAudioPrefix(messageId) }));
  const keys = (listed.Contents ?? []).map((o) => o.Key!).filter(Boolean).sort();
  return Promise.all(keys.map((Key) => getSignedUrl(s.s3, new GetObjectCommand({ Bucket: s.bucket, Key }), { expiresIn: expiresInS })));
}

/** Delete audio older than the retention window. Returns the message ids whose audio was removed. */
export async function deleteExpiredAudio(retentionDays: number, now = new Date()): Promise<{ deletedObjects: number; messageIds: string[] }> {
  const s = storage();
  if (!s) return { deletedObjects: 0, messageIds: [] };
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  let token: string | undefined;
  do {
    const page = await s.s3.send(new ListObjectsV2Command({ Bucket: s.bucket, Prefix: AUDIO_PREFIX, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key && o.LastModified && o.LastModified.getTime() < cutoff) expired.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  for (let i = 0; i < expired.length; i += 1000) {
    await s.s3.send(
      new DeleteObjectsCommand({ Bucket: s.bucket, Delete: { Objects: expired.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } })
    );
  }
  const messageIds = [...new Set(expired.map((k) => k.slice(AUDIO_PREFIX.length).split("/")[0]))];
  return { deletedObjects: expired.length, messageIds };
}
