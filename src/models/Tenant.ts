import { Schema, model, Types } from 'mongoose';

export interface IDaySchedule {
  day: number; // 0=Dom, 1=Lun … 6=Sab
  open: string; // "09:00"
  close: string; // "18:00"
}

/**
 * Donde el cliente deposita el adelanto. Se muestra tal cual en el checkout,
 * asi que `details` es texto libre: cada negocio lo escribe a su manera
 * ("Yape al 987654321 - Maria S.", "BCP soles 191-xxxx").
 */
export interface IPaymentMethod {
  /** "Yape", "Plin", "BCP", "Efectivo contra entrega". */
  name: string;
  details?: string;
  /** QR de Yape/Plin para que el cliente solo escanee. */
  qrImageUrl?: string;
}

export interface ITenant {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  logoUrl?: string;
  /** Solo digitos con codigo de pais, ej. 51987654321. Alimenta el boton de WhatsApp de la tienda. */
  phone?: string;
  /** Hex "#rrggbb". Tine la tienda publica y las campanas; el front deriva la escala completa. */
  brandColor?: string;
  /** Horario de atencion del negocio. No confundir con las franjas de delivery. */
  schedule?: IDaySchedule[];
  /** Que entregas acepta la tienda publica. Vacio = no se puede comprar online. */
  deliveryTypes?: ('pickup' | 'delivery_own')[];
  /** Franjas en las que reparte, cuando acepta delivery. */
  deliveryFranjas?: ('morning' | 'afternoon' | 'evening')[];
  /** Donde pagar el adelanto. Sin esto no se puede pedir comprobante. */
  paymentMethods?: IPaymentMethod[];
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
    brandColor: { type: String, trim: true },
    schedule: [
      {
        day: { type: Number, required: true, min: 0, max: 6 },
        open: { type: String, required: true },
        close: { type: String, required: true },
        _id: false,
      },
    ],
    deliveryTypes: {
      type: [String],
      enum: ['pickup', 'delivery_own'],
      default: [],
    },
    deliveryFranjas: {
      type: [String],
      enum: ['morning', 'afternoon', 'evening'],
      default: [],
    },
    paymentMethods: {
      type: [
        new Schema<IPaymentMethod>(
          {
            name: { type: String, required: true, trim: true },
            details: { type: String, trim: true },
            qrImageUrl: { type: String },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Tenant = model<ITenant>('Tenant', tenantSchema);
