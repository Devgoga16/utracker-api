import dotenv from 'dotenv';

dotenv.config();

/** "http://a.com, https://b.com" -> ['http://a.com', 'https://b.com'] */
function corsOriginList(): string[] {
  const raw = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  const list = raw
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return list.length ? list : ['http://localhost:5173'];
}

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

  /**
   * Origenes permitidos, separados por coma. El front llama a la API desde
   * otro dominio, asi que sin esto el navegador bloquea todo. Acepta varios
   * para cubrir local y los previews de Vercel a la vez.
   */
  corsOrigins: corsOriginList(),

  /**
   * Base publica del front. Alimenta los links de seguimiento que salen por
   * WhatsApp, donde una URL relativa no sirve de nada. Cae al primer origen
   * de CORS porque en la practica es el mismo dominio.
   */
  frontendUrl: (process.env.FRONTEND_URL?.trim() || corsOriginList()[0]).replace(/\/$/, ''),

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

  // Opcional igual que R2: sin esto la API arranca, solo no manda WhatsApp.
  whatsapp: {
    /**
     * URL completa de envio del bot compartido, con su sesion incluida.
     * Es el valor por defecto para los negocios sin sesion propia.
     */
    sendUrl: process.env.WHATSAPP_SEND_URL?.trim(),
    apiKey: process.env.WHATSAPP_API_KEY,
  },
};

export function isStorageConfigured(): boolean {
  const { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl } = env.r2;
  return Boolean(accountId && accessKeyId && secretAccessKey && bucket && publicBaseUrl);
}

export function isWhatsappConfigured(): boolean {
  return Boolean(env.whatsapp.sendUrl && env.whatsapp.apiKey);
}

/**
 * Decide si un origen puede llamar a la API.
 *
 * Acepta comodines ("https://*.vercel.app") porque los previews de Vercel
 * estrenan subdominio en cada deploy y listarlos uno por uno es imposible.
 * El `*` no cruza puntos, asi que un comodin de un nivel no habilita
 * subdominios mas profundos de los que se quiso permitir.
 */
export function isOriginAllowed(origin: string): boolean {
  const clean = origin.replace(/\/$/, '');

  return env.corsOrigins.some((allowed) => {
    if (!allowed.includes('*')) return allowed === clean;

    const pattern = allowed
      .split('*')
      .map((chunk) => chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^.]*');

    return new RegExp(`^${pattern}$`).test(clean);
  });
}
