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
  /** Umbral por defecto de stock bajo, para productos sin uno propio. */
  lowStockThreshold?: number;
  /**
   * Sesion propia de WhatsApp. Vacio = usa el bot compartido de uTracker.
   *
   * Lo configura el superadmin tras acordarlo con el negocio: una sesion
   * propia cuesta mas pero manda desde el numero del negocio.
   *
   * `apiKey` es secreto: no sale en ninguna respuesta al dueno ni al publico.
   */
  whatsapp?: {
    sendUrl?: string;
    apiKey?: string;
  };
  /**
   * Si aparece como socio en la web de uTracker.
   *
   * Arranca apagado a propósito: mostrar el nombre y el logo de un negocio
   * para promocionar uTracker es usar su marca, y eso necesita su permiso.
   * Que su tienda sea pública no alcanza: ahí se muestra a sus clientes, no
   * hace publicidad para nosotros. Lo prende el dueño o el superadmin después
   * de hablarlo con él.
   */
  showcase?: boolean;
  /**
   * Código para invitar a otros negocios ("DOMINOR"). Se crea la primera vez
   * que el dueño abre «Invita y gana», no al crear el negocio: la mayoría de
   * negocios viejos no lo tiene y no hace falta migrarlos.
   */
  referralCode?: string;
  /** El negocio que lo invitó. Solo se fija al crearse, nunca después. */
  referredBy?: Types.ObjectId;
  /**
   * El superadmin anuló el referido (mismo dueño en los dos negocios, cuenta
   * de prueba...). Deja de dar descuento a los dos lados.
   */
  referralRejectedAt?: Date;
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
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    whatsapp: {
      type: new Schema(
        {
          sendUrl: { type: String, trim: true },
          apiKey: { type: String, trim: true },
        },
        { _id: false },
      ),
      // `select: false` para que no viaje por accidente en consultas generales.
      select: false,
    },
    showcase: { type: Boolean, default: false },
    // `sparse`: los negocios sin código no chocan entre sí como duplicados de null.
    referralCode: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'Tenant', index: true },
    referralRejectedAt: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Tenant = model<ITenant>('Tenant', tenantSchema);
