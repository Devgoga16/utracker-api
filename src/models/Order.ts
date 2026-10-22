import { randomBytes } from 'crypto';
import { Schema, model, Types } from 'mongoose';

export type OrderType = 'pickup' | 'delivery_third_party' | 'delivery_own';
export type OrderCreatedVia = 'manual' | 'order_link' | 'store' | 'pos';

/** Cómo se cobró. Hasta el punto de venta no se guardaba: solo cuánto. */
export type PaymentMethodKind = 'cash' | 'yape' | 'plin' | 'card' | 'transfer' | 'other';
export const PAYMENT_METHOD_KINDS: PaymentMethodKind[] = ['cash', 'yape', 'plin', 'card', 'transfer', 'other'];
export type Franja = 'morning' | 'afternoon' | 'evening';

export interface IScheduledFor {
  date: string; // "2026-08-20"
  /** Opcional: un negocio puede agendar el dia sin partirlo en franjas. */
  franja?: Franja;
}

export interface IOrderItem {
  /** Absent on ad-hoc lines: one-off jobs that are not worth a catalog entry. */
  product?: Types.ObjectId;
  name: string;
  unitPrice: number;
  quantity: number;
  variant?: string;
  /** Per-order detail of the work: "2x3m, texto 'Panaderia Rosa', LED azul". */
  specs?: string;
}

export interface IDeliveryAttempt {
  attemptedAt: Date;
  succeeded: boolean;
  reason?: string;
  note?: string;
}

export interface IDeliveryInfo {
  address?: string;
  reference?: string;
  courierName?: string; // delivery_third_party
  trackingCode?: string; // delivery_third_party
  driver?: Types.ObjectId; // delivery_own -> User with role 'driver'
  attempts: IDeliveryAttempt[];
  maxAttempts: number;
}

/**
 * The name/color/icon are frozen at the moment of the transition, the same way
 * OrderItem freezes the price: editing a workflow state later must not rewrite
 * what this order actually went through. `state` is kept only for linkage.
 */
export interface IPaymentEntry {
  /** Los pagos anteriores a este cambio no lo traían: se les asigna al abrir el pedido. */
  _id?: Types.ObjectId;
  /** Se deduce del monto: «adelanto» si deja saldo, «saldo» si completa el total. */
  kind: 'advance' | 'balance';
  amount: number;
  proofImageUrl?: string;
  note?: string;
  /**
   * false mientras el negocio no confirme que el dinero llego.
   *
   * Un adelanto que sube el cliente desde la tienda entra sin validar: hasta
   * que el dueno lo revise no cuenta como pagado ni mueve el estado de pago.
   * Lo que registra el dueno a mano nace validado, que es como funcionaba
   * antes de que existiera este campo.
   */
  validated: boolean;
  validatedAt?: Date;
  registeredAt: Date;
  registeredBy?: Types.ObjectId;
  /** Opcional: los pagos de antes del punto de venta no lo tienen. */
  method?: PaymentMethodKind;
  /** Con cuánto pagó en efectivo. El vuelto es esto menos `amount`. */
  received?: number;
  /** La caja en la que entró el dinero, si había una abierta. */
  cashSession?: Types.ObjectId;
}

export interface IStateHistoryEntry {
  kind: 'fulfillment' | 'payment';
  state: Types.ObjectId;
  stateName: string;
  stateColor: string;
  stateIcon?: string;
  changedAt: Date;
  changedBy?: Types.ObjectId;
  /** Por qué: el motivo de una cancelación, una devolución. */
  note?: string;
}

/**
 * Dinero que se le devolvió al cliente.
 *
 * Va aparte de los pagos y no como un pago negativo: así lo cobrado y lo
 * devuelto se leen por separado en el pedido, en finanzas y en la caja.
 */
export interface IRefund {
  _id?: Types.ObjectId;
  amount: number;
  method?: PaymentMethodKind;
  note?: string;
  at: Date;
  by?: Types.ObjectId;
  /** La caja de la que salió, si había una abierta. */
  cashSession?: Types.ObjectId;
}

export interface IOrder {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  /** Public, unguessable handle for the customer tracking page. Never expose _id: it is enumerable. */
  trackingToken: string;
  customer: Types.ObjectId;
  items: IOrderItem[];
  totalAmount: number;
  type: OrderType;
  delivery?: IDeliveryInfo;
  fulfillmentState: Types.ObjectId;
  paymentState: Types.ObjectId;
  stateHistory: IStateHistoryEntry[];
  payments: IPaymentEntry[];
  refunds: IRefund[];
  createdVia: OrderCreatedVia;
  orderLink?: Types.ObjectId;
  campaign?: Types.ObjectId;
  /** true mientras el pedido está cancelado y su stock ya fue devuelto. Evita devolver dos veces. */
  stockReleased?: boolean;
  /**
   * Cuando el negocio rechazó un comprobante del cliente.
   *
   * El pago rechazado se borra, así que sin esta marca el seguimiento no
   * tendría cómo saber que hay algo que regularizar. Se limpia en cuanto
   * entra o se valida un pago nuevo.
   */
  paymentRejectedAt?: Date;
  fulfillmentLink?: string;
  /** La caja en la que se hizo, si es una venta de mostrador. Queda aunque se anule. */
  cashSession?: Types.ObjectId;
  /** Venta de mostrador anulada: cuándo y quién. El dinero se devolvió. */
  voidedAt?: Date;
  voidedBy?: Types.ObjectId;
  scheduledFor?: IScheduledFor;
  notes?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    variant: { type: String },
    specs: { type: String },
  },
  { _id: false }
);

const deliveryAttemptSchema = new Schema<IDeliveryAttempt>(
  {
    attemptedAt: { type: Date, default: Date.now },
    succeeded: { type: Boolean, required: true },
    reason: { type: String },
    note: { type: String },
  },
  { _id: false }
);

const deliveryInfoSchema = new Schema<IDeliveryInfo>(
  {
    address: { type: String },
    reference: { type: String },
    courierName: { type: String },
    trackingCode: { type: String },
    driver: { type: Schema.Types.ObjectId, ref: 'User' },
    attempts: { type: [deliveryAttemptSchema], default: [] },
    maxAttempts: { type: Number, default: 3 },
  },
  { _id: false }
);

const paymentEntrySchema = new Schema<IPaymentEntry>(
  {
    kind: { type: String, enum: ['advance', 'balance'], required: true },
    amount: { type: Number, required: true, min: 0 },
    proofImageUrl: { type: String },
    note: { type: String },
    // Los pagos que ya existian se dan por validados: antes no habia revision.
    validated: { type: Boolean, default: true },
    validatedAt: { type: Date },
    registeredAt: { type: Date, default: Date.now },
    registeredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    method: { type: String, enum: PAYMENT_METHOD_KINDS },
    received: { type: Number, min: 0 },
    cashSession: { type: Schema.Types.ObjectId, ref: 'CashSession' },
  },
  // Con _id: un pedido puede tener varios pagos y hay que poder señalar uno.
  { _id: true }
);

const stateHistorySchema = new Schema<IStateHistoryEntry>(
  {
    kind: { type: String, enum: ['fulfillment', 'payment'], required: true },
    state: { type: Schema.Types.ObjectId, ref: 'WorkflowState', required: true },
    stateName: { type: String, required: true },
    stateColor: { type: String, required: true },
    stateIcon: { type: String },
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const refundSchema = new Schema<IRefund>({
  amount: { type: Number, required: true, min: 0 },
  method: { type: String, enum: PAYMENT_METHOD_KINDS },
  note: { type: String, trim: true },
  at: { type: Date, default: Date.now },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  cashSession: { type: Schema.Types.ObjectId, ref: 'CashSession' },
});

const orderSchema = new Schema<IOrder>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    trackingToken: { type: String, required: true, unique: true, default: () => randomBytes(16).toString('hex') },
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    items: { type: [orderItemSchema], required: true, validate: (v: unknown[]) => v.length > 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    type: { type: String, enum: ['pickup', 'delivery_third_party', 'delivery_own'], required: true },
    delivery: { type: deliveryInfoSchema },
    fulfillmentState: { type: Schema.Types.ObjectId, ref: 'WorkflowState', required: true },
    paymentState: { type: Schema.Types.ObjectId, ref: 'WorkflowState', required: true },
    stateHistory: { type: [stateHistorySchema], default: [] },
    payments: { type: [paymentEntrySchema], default: [] },
    refunds: { type: [refundSchema], default: [] },
    createdVia: { type: String, enum: ['manual', 'order_link', 'store', 'pos'], default: 'manual' },
    orderLink: { type: Schema.Types.ObjectId, ref: 'OrderLink' },
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign' },
    stockReleased: { type: Boolean, default: false },
    paymentRejectedAt: { type: Date },
    fulfillmentLink: { type: String },
    cashSession: { type: Schema.Types.ObjectId, ref: 'CashSession' },
    voidedAt: { type: Date },
    voidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    scheduledFor: {
      type: new Schema<IScheduledFor>(
        {
          date: { type: String, required: true },
          franja: { type: String, enum: ['morning', 'afternoon', 'evening'] },
        },
        { _id: false }
      ),
    },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

orderSchema.index({ tenant: 1, createdAt: -1 });
orderSchema.index({ tenant: 1, fulfillmentState: 1 });
// El calendario consulta por rango de fecha programada.
orderSchema.index({ tenant: 1, 'scheduledFor.date': 1 });
// El cuadre de una caja suma los pagos que entraron en ella.
orderSchema.index({ 'payments.cashSession': 1 }, { sparse: true });
orderSchema.index({ cashSession: 1, createdAt: -1 }, { sparse: true });
orderSchema.index({ 'refunds.cashSession': 1 }, { sparse: true });

export const Order = model<IOrder>('Order', orderSchema);
