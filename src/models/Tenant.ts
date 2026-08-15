import { Schema, model, Types } from 'mongoose';

export interface ITenant {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  logoUrl?: string;
  /** Solo digitos con codigo de pais, ej. 51987654321. Alimenta el boton de WhatsApp de la tienda. */
  phone?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const tenantSchema = new Schema<ITenant>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    logoUrl: { type: String },
    phone: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Tenant = model<ITenant>('Tenant', tenantSchema);
