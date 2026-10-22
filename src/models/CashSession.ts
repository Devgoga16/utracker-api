import { Schema, model, Types } from 'mongoose';
import { PAYMENT_METHOD_KINDS, PaymentMethodKind } from './Order';

/**
 * Un turno de caja: desde que se abre con el sencillo hasta que se cuenta y
 * se cierra.
 *
 * Las ventas no viven aquí: cada pago guarda en qué caja entró
 * (`payments.cashSession`) y el cuadre se calcula sumándolos. Así una venta
 * anulada mientras la caja sigue abierta descuadra lo que tiene que
 * descuadrar, sin mantener dos copias de la misma cifra.
 *
 * Al cerrar se congela el resumen: lo que se contó ese día no debe cambiar
 * porque alguien toque un pedido una semana después.
 */
export type CashMovementType = 'in' | 'out';

export interface ICashMovement {
  type: CashMovementType;
  amount: number;
  note?: string;
  at: Date;
  by?: Types.ObjectId;
}

export interface ICashSummary {
  salesCount: number;
  salesTotal: number;
  /** Lo cobrado por medio de pago, ventas y pagos de pedidos juntos. */
  byMethod: Partial<Record<PaymentMethodKind, number>>;
  /** Devuelto a clientes desde esta caja; ya está restado de `byMethod`. */
  refunds?: number;
  cashIn: number;
  cashOut: number;
  /** Inicial + efectivo cobrado + ingresos − retiros. */
  expectedCash: number;
}

export interface ICashSession {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  status: 'open' | 'closed';
  openingAmount: number;
  openedAt: Date;
  openedBy?: Types.ObjectId;
  movements: ICashMovement[];
  closedAt?: Date;
  closedBy?: Types.ObjectId;
  /** Lo que de verdad había en el cajón al cerrar. */
  countedCash?: number;
  /** contado − esperado: negativo es faltante, positivo sobrante. */
  difference?: number;
  closingNote?: string;
  summary?: ICashSummary;
  createdAt: Date;
  updatedAt: Date;
}

const movementSchema = new Schema<ICashMovement>(
  {
    type: { type: String, enum: ['in', 'out'], required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true },
    at: { type: Date, default: Date.now },
    by: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

const summarySchema = new Schema<ICashSummary>(
  {
    salesCount: { type: Number, default: 0 },
    salesTotal: { type: Number, default: 0 },
    byMethod: {
      type: new Schema(
        Object.fromEntries(PAYMENT_METHOD_KINDS.map((m) => [m, { type: Number }])),
        { _id: false },
      ),
      default: {},
    },
    refunds: { type: Number, default: 0 },
    cashIn: { type: Number, default: 0 },
    cashOut: { type: Number, default: 0 },
    expectedCash: { type: Number, default: 0 },
  },
  { _id: false },
);

const cashSessionSchema = new Schema<ICashSession>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    openingAmount: { type: Number, required: true, min: 0 },
    openedAt: { type: Date, default: Date.now },
    openedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    movements: { type: [movementSchema], default: [] },
    closedAt: { type: Date },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    countedCash: { type: Number, min: 0 },
    difference: { type: Number },
    closingNote: { type: String, trim: true },
    summary: { type: summarySchema },
  },
  { timestamps: true },
);

/**
 * Una sola caja abierta por negocio. Lo garantiza la base y no solo el
 * controlador: dos personas abriendo a la vez desde dos celulares terminarían
 * con las ventas repartidas en dos cajas que nadie cuadra.
 */
cashSessionSchema.index(
  { tenant: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);
cashSessionSchema.index({ tenant: 1, openedAt: -1 });

export const CashSession = model<ICashSession>('CashSession', cashSessionSchema);
