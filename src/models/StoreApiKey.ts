import { Schema, model, Types } from 'mongoose';
import { randomBytes } from 'crypto';

/**
 * Llave publicable para que una web externa arme su tienda con este catálogo.
 *
 * Es publicable a proposito, como las `pk_` de Stripe: viaja en el navegador
 * del visitante, asi que se guarda en claro y no se trata como secreto. Solo
 * habilita lo que ya es publico —catalogo y crear una sesion de checkout— y
 * nunca pedidos, clientes ni ajustes. Si se filtra, se revoca y listo.
 */
export interface IStoreApiKey {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  /** Para que el dueno distinga entre varias: "Mi web", "Landing de navidad". */
  name: string;
  key: string;
  /** Dominios que pueden usarla. Vacio = cualquiera. */
  allowedOrigins: string[];
  revokedAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function generateStoreKey(): string {
  return `utk_live_${randomBytes(18).toString('hex')}`;
}

const storeApiKeySchema = new Schema<IStoreApiKey>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    key: { type: String, required: true, unique: true },
    allowedOrigins: { type: [String], default: [] },
    revokedAt: { type: Date },
    lastUsedAt: { type: Date },
  },
  { timestamps: true },
);

export const StoreApiKey = model<IStoreApiKey>('StoreApiKey', storeApiKeySchema);
