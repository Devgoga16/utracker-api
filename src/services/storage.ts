import { randomUUID } from 'crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env, isStorageConfigured } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * Cloudflare R2 is S3-compatible, so the AWS SDK works as-is against the
 * account endpoint. Region must be 'auto' -- R2 has no regions.
 */
let client: S3Client | null = null;

function getClient(): S3Client {
  if (!isStorageConfigured()) {
    throw ApiError.serviceUnavailable(
      'El almacenamiento de imágenes no está configurado. Faltan las variables R2_* en el .env.'
    );
  }

  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.r2.accessKeyId!,
      secretAccessKey: env.r2.secretAccessKey!,
    },
  });

  return client;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/**
 * A client-declared content type is trivially spoofable, so the bytes get the
 * final word. Returns the detected mime or null when it is not an image we take.
 */
function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  // RIFF....WEBP
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }

  // ISO-BMFF box 'ftyp' with an AVIF brand
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  return null;
}

export interface UploadedObject {
  url: string;
  key: string;
  contentType: string;
  size: number;
}

export async function uploadImage(
  buffer: Buffer,
  tenantId: string,
  folder: string
): Promise<UploadedObject> {
  if (buffer.length > env.r2.maxUploadBytes) {
    const mb = (env.r2.maxUploadBytes / 1024 / 1024).toFixed(1);
    throw ApiError.badRequest(`La imagen supera el máximo de ${mb} MB`);
  }

  const contentType = sniffImageMime(buffer);
  if (!contentType) {
    throw ApiError.badRequest('Formato no soportado. Usá JPG, PNG, WebP o AVIF.');
  }

  // Tenant-scoped and random: keys are never guessable from one another.
  const key = `${tenantId}/${folder}/${randomUUID()}.${MIME_BY_EXTENSION[contentType]}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: env.r2.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  return { url: `${env.r2.publicBaseUrl}/${key}`, key, contentType, size: buffer.length };
}

/** Recovers the object key from a stored public URL, or null if it is external. */
export function keyFromUrl(url: string): string | null {
  const base = env.r2.publicBaseUrl;
  if (!base || !url.startsWith(`${base}/`)) return null;
  return url.slice(base.length + 1);
}

/**
 * Deleting images is housekeeping, never the point of the request -- a failure
 * here must not fail the product deletion that triggered it.
 */
export async function deleteByUrl(url: string): Promise<void> {
  const key = keyFromUrl(url);
  if (!key || !isStorageConfigured()) return;

  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key }));
  } catch (err) {
    console.error('[storage] no se pudo borrar', key, err);
  }
}
