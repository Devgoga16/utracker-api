import { Schema, model, Types } from 'mongoose';

export interface IDaySchedule {
  day: number; // 0=Dom, 1=Lun … 6=Sab
  open: string; // "09:00"
  close: string; // "18:00"
}

export interface ITenant {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  logoUrl?: string;
  /** Solo digitos con codigo de pais, ej. 51987654321. Alimenta el boton de WhatsApp de la tienda. */
  phone?: string;
  schedule?: IDaySchedule[];
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
    schedule: [
      {
        day: { type: Number, required: true, min: 0, max: 6 },
        open: { type: String, required: true },
        close: { type: String, required: true },
        _id: false,
      },
    ],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Tenant = model<ITenant>('Tenant', tenantSchema);
