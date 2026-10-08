import { SystemLog, LogLevel, LogSource, newLogRef } from '../models/SystemLog';

/** Cuántos días se guardan los logs antes de que Mongo los borre solo. */
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 30);

const MAX_MESSAGE = 1_000;
const MAX_STACK = 6_000;
const MAX_CONTEXT_CHARS = 4_000;

/** Nombres que nunca deben quedar escritos en un log. */
const SECRET_KEYS = /pass|secret|token|apikey|api_key|authorization|credential/i;

/**
 * Copia el contexto sin secretos y sin profundidad infinita.
 *
 * El contexto suele ser el body de una request, y ahí viajan contraseñas y API
 * keys. Un log es justamente lo que se comparte para diagnosticar, así que es
 * el peor lugar posible para que aparezcan.
 */
function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[…]';

  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) ? '[oculto]' : redact(raw, depth + 1);
  }
  return out;
}

function fitContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const clean = redact(context) as Record<string, unknown>;
  // Un body enorme no aporta nada y engorda la colección.
  const json = JSON.stringify(clean);
  if (json && json.length > MAX_CONTEXT_CHARS) {
    return { truncated: true, preview: json.slice(0, MAX_CONTEXT_CHARS) };
  }
  return clean;
}

export interface LogEventInput {
  level: LogLevel;
  source: LogSource;
  message: string;
  action?: string;
  statusCode?: number;
  tenant?: string | null;
  user?: string | null;
  stack?: string;
  context?: Record<string, unknown>;
  /** Para reusar un ref ya entregado al usuario. */
  ref?: string;
}

/**
 * Escribe un evento en el visor de logs y devuelve su `ref`.
 *
 * No se espera (`void logEvent(...)` es el uso normal) y nunca lanza: si falla
 * guardar el log, la request original debe seguir su curso igual. Un sistema
 * que se cae porque no pudo registrar que algo se cayó no sirve de nada.
 */
export function logEvent(input: LogEventInput): string {
  const ref = input.ref ?? newLogRef();

  const doc = {
    ref,
    level: input.level,
    source: input.source,
    message: String(input.message ?? 'Error sin mensaje').slice(0, MAX_MESSAGE),
    action: input.action,
    statusCode: input.statusCode,
    tenant: input.tenant || undefined,
    user: input.user || undefined,
    stack: input.stack?.slice(0, MAX_STACK),
    context: fitContext(input.context),
    expiresAt: new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
  };

  SystemLog.create(doc).catch((err) => {
    // Solo a la consola: insistir contra la base que acaba de fallar no ayuda.
    console.error('[systemLog] no se pudo guardar el evento', err?.message ?? err);
  });

  return ref;
}

/** Atajo para registrar algo que hizo soporte dentro de un negocio. */
export function logSupportAction(input: Omit<LogEventInput, 'level' | 'source'>): string {
  return logEvent({ ...input, level: 'info', source: 'support' });
}

export const logRetentionDays = RETENTION_DAYS;
