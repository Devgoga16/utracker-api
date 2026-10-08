import { Schema, model, Types } from 'mongoose';
import { randomBytes } from 'crypto';

export type LogLevel = 'error' | 'warn' | 'info';

/** De dónde salió el evento. Sirve para separar "se rompió la API" de "se rompió el navegador del cliente". */
export type LogSource = 'api' | 'web' | 'whatsapp' | 'storefront' | 'support' | 'job';

export interface ISystemLog {
  _id: Types.ObjectId;
  /**
   * Código corto que también se le muestra a quien sufrió el error.
   *
   * Es el puente entre las dos puntas: el usuario dice "me salió E3F9A1C2" y
   * el log con el stack completo aparece de una búsqueda, sin tener que
   * adivinar a qué de todo lo que pasó esa tarde se refiere.
   */
  ref: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  /** "POST /api/orders", "validatePayment", "whatsapp:send". */
  action?: string;
  statusCode?: number;
  tenant?: Types.ObjectId;
  user?: Types.ObjectId;
  stack?: string;
  /** Lo que haga falta para reproducirlo: body recortado, ids, URL del navegador. */
  context?: Record<string, unknown>;
  /** Fecha de borrado automático: los logs no son para guardar para siempre. */
  expiresAt: Date;
  createdAt: Date;
}

export function newLogRef(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

const systemLogSchema = new Schema<ISystemLog>(
  {
    ref: { type: String, required: true, unique: true, default: newLogRef },
    level: { type: String, enum: ['error', 'warn', 'info'], required: true, index: true },
    source: {
      type: String,
      enum: ['api', 'web', 'whatsapp', 'storefront', 'support', 'job'],
      required: true,
    },
    message: { type: String, required: true },
    action: { type: String },
    statusCode: { type: Number },
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    stack: { type: String },
    context: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// El visor siempre pide "lo último", filtrando por nivel o por negocio.
systemLogSchema.index({ createdAt: -1 });
systemLogSchema.index({ level: 1, createdAt: -1 });
systemLogSchema.index({ tenant: 1, createdAt: -1 });

// Mongo borra el documento cuando `expiresAt` queda en el pasado.
systemLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SystemLog = model<ISystemLog>('SystemLog', systemLogSchema);
