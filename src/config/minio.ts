import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "stream";
import "dotenv/config";

// Read MinIO configuration from environment variables
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "localhost";
const MINIO_PORT = process.env.MINIO_PORT ? parseInt(process.env.MINIO_PORT, 10) : 9000;
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === "true";
export const MINIO_BUCKET = (process.env.MINIO_BUCKET || "motovumedia").replace(/['"]/g, "").trim();
const MINIO_ACCESS_KEY = (process.env.MINIO_ACCESS_KEY || "").replace(/['"]/g, "").trim();
const MINIO_SECRET_KEY = (process.env.MINIO_SECRET_KEY || "").replace(/['"]/g, "").trim();

const protocol = MINIO_USE_SSL ? "https" : "http";
const endpointUrl = `${protocol}://${MINIO_ENDPOINT}:${MINIO_PORT}`;

/**
 * MinIO S3 Client instance
 * - forcePathStyle: true is required for MinIO (http://localhost:9000/bucket/key)
 */
export const s3Client = new S3Client({
  endpoint: endpointUrl,
  region: "us-east-1",
  credentials: {
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

let bucketChecked = false;

/**
 * Ensures the target MinIO bucket exists.
 * If the bucket does not exist, it creates it automatically.
 */
export async function ensureBucketExists(): Promise<void> {
  if (bucketChecked) return;

  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: MINIO_BUCKET }));
    bucketChecked = true;
  } catch (err: any) {
    const isNotFound =
      err.name === "NotFound" ||
      err.$metadata?.httpStatusCode === 404 ||
      err.message?.includes("NotFound");

    if (isNotFound) {
      console.log(`[MinIO] Bucket "${MINIO_BUCKET}" not found. Creating bucket...`);
      try {
        await s3Client.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET }));
        console.log(`[MinIO] Bucket "${MINIO_BUCKET}" created successfully.`);
        bucketChecked = true;
      } catch (createErr: any) {
        console.error(`[MinIO] Failed to create bucket "${MINIO_BUCKET}":`, createErr.message);
        throw createErr;
      }
    } else {
      console.warn(`[MinIO] Bucket verification warning: ${err.message}`);
    }
  }
}

/**
 * Multi-tenant safe object key generator.
 * Format: tenants/{orgId}/messages/{messageId}/{attachmentId}_{cleanFilename}
 * 
 * Enforces strict multi-tenancy at the object storage level.
 */
export function buildTenantObjectKey(
  orgId: string,
  messageId: string,
  attachmentId: string,
  originalFilename: string = "image"
): string {
  // Sanitize filename to alphanumeric and safe symbols
  const cleanName = originalFilename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+/, "") || "image";

  return `tenants/${orgId}/messages/${messageId}/${attachmentId}_${cleanName}`;
}

/**
 * Uploads a binary buffer to MinIO bucket
 */
export async function uploadToMinIO(params: {
  key: string;
  buffer: Buffer;
  contentType: string;
}): Promise<void> {
  await ensureBucketExists();

  await s3Client.send(
    new PutObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: params.key,
      Body: params.buffer,
      ContentType: params.contentType,
    })
  );
}

/**
 * Generates a presigned GET URL for an object (valid for 24 hours by default).
 * Clients can directly fetch/render the image from MinIO using this URL.
 */
export async function getPresignedDownloadUrl(
  key: string,
  expiresInSeconds: number = 86400
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: MINIO_BUCKET,
    Key: key,
  });

  return await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

/**
 * Retrieves an object stream directly from MinIO.
 * Useful for the backend proxy endpoint so clients can stream images securely.
 */
export async function getObjectFromMinIO(key: string): Promise<{
  stream: Readable;
  contentType: string;
  contentLength?: number;
}> {
  const command = new GetObjectCommand({
    Bucket: MINIO_BUCKET,
    Key: key,
  });

  const response = await s3Client.send(command);

  return {
    stream: response.Body as Readable,
    contentType: response.ContentType || "application/octet-stream",
    contentLength: response.ContentLength,
  };
}

/**
 * Deletes an object from MinIO bucket
 */
export async function deleteFromMinIO(key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: key,
    })
  );
}

