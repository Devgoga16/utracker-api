import { Schema, model, Types } from 'mongoose';
import { randomBytes } from 'crypto';

export type CheckoutSessionStatus = 'pending' | 'completed' | 'expired';

export interface ICheckoutSessionItem {
  product: Types.ObjectId;
  quantity: number;
  variant?: string;
}

/**
 * El carrito que una web externa manda a cobrar, esperando a que el cliente
 * complete sus datos en la pantalla de uTracker.
 *
 * Guarda solo que se pidio, nunca precios: el total se recalcula al confirmar
 * contra el catalogo vivo. Si se guardara el precio, una sesion vieja podria
 * cobrar al precio de ayer.
 */
export interface ICheckoutSession {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  token: string;
  apiKey?: Types.ObjectId;
  items: ICheckoutSessionItem[];
  status: CheckoutSessionStatus;
  /** A donde volver al terminar, si el tercero lo indico. */
  returnUrl?: string;
  resultingOrder?: Types.ObjectId;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function generateSessionToken(): string {
  return randomBytes(16).toString('hex');
}

const itemSchema = new Schema<ICheckoutSessionItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
    variant: { type: String },
  },
  { _id: false },
);

const checkoutSessionSchema = new Schema<ICheckoutSession>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    token: { type: String, required: true, unique: true },
    apiKey: { type: Schema.Types.ObjectId, ref: 'StoreApiKey' },
    items: { type: [itemSchema], required: true },
    status: {
      type: String,
      enum: ['pending', 'completed', 'expired'],
      default: 'pending',
    },
    returnUrl: { type: String },
    resultingOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Mongo limpia solas las sesiones vencidas: son basura sin valor historico.
checkoutSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CheckoutSession = model<ICheckoutSession>('CheckoutSession', checkoutSessionSchema);
