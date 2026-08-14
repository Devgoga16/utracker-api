import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  mongodbUri: required('MONGODB_URI'),
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },
  orderLinkTtlHours: Number(process.env.ORDER_LINK_TTL_HOURS ?? 24),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',

  // Optional on purpose: the API must still boot without storage configured.
  // `isStorageConfigured()` gates the upload endpoint at request time instead.
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, ''),
    maxUploadBytes: Number(process.env.R2_MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024),
  },
};

export function isStorageConfigured(): boolean {
  const { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl } = env.r2;
  return Boolean(accountId && accessKeyId && secretAccessKey && bucket && publicBaseUrl);
}
