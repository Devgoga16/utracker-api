import { randomBytes } from 'crypto';
import { Schema, model, Types } from 'mongoose';

export type OrderType = 'pickup' | 'delivery_third_party' | 'delivery_own';
export type OrderCreatedVia = 'manual' | 'order_link';

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
  kind: 'advance' | 'balance';
  amount: number;
  proofImageUrl?: string;
  note?: string;
  registeredAt: Date;
  registeredBy?: Types.ObjectId;
}

export interface IStateHistoryEntry {
  kind: 'fulfillment' | 'payment';
  state: Types.ObjectId;
  stateName: string;
  stateColor: string;
  stateIcon?: string;
  changedAt: Date;
  changedBy?: Types.ObjectId;
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
  createdVia: OrderCreatedVia;
  orderLink?: Types.ObjectId;
  fulfillmentLink?: string;
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
    registeredAt: { type: Date, default: Date.now },
    registeredBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
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
  },
  { _id: false }
);

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
    createdVia: { type: String, enum: ['manual', 'order_link'], default: 'manual' },
    orderLink: { type: Schema.Types.ObjectId, ref: 'OrderLink' },
    fulfillmentLink: { type: String },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

orderSchema.index({ tenant: 1, createdAt: -1 });
orderSchema.index({ tenant: 1, fulfillmentState: 1 });

export const Order = model<IOrder>('Order', orderSchema);
