import { Schema, model, Types } from 'mongoose';

/**
 * Permiso temporal para que un superadmin entre al panel de un negocio.
 *
 * La alternativa —que el superadmin pueda tocar cualquier negocio siempre, por
 * ser superadmin— no deja rastro de quién miró qué. Acá cada acceso es un
 * documento con motivo, duración y autor, y todo lo que se escriba mientras
 * esté vigente queda en los logs marcado como soporte.
 */
export interface ISupportAccess {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  /** El superadmin que pidió entrar. */
  user: Types.ObjectId;
  reason: string;
  /** false = solo mirar. Alcanza para la mayoría de los diagnósticos. */
  canWrite: boolean;
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const supportAccessSchema = new Schema<ISupportAccess>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    canWrite: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

// Los accesos no se borran: son la bitácora de quién entró a cada negocio.
supportAccessSchema.index({ tenant: 1, createdAt: -1 });
supportAccessSchema.index({ user: 1, expiresAt: -1 });

export const SupportAccess = model<ISupportAccess>('SupportAccess', supportAccessSchema);

/** El acceso vigente de este superadmin a este negocio, si lo hay. */
export function findActiveAccess(tenantId: string, userId: string) {
  return SupportAccess.findOne({
    tenant: tenantId,
    user: userId,
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 });
}
