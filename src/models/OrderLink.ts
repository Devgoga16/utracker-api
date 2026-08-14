import { Schema, model, Types } from 'mongoose';

export type OrderLinkStatus = 'pending' | 'used' | 'expired' | 'cancelled';
export type OrderLinkDeliveryType = 'pickup' | 'delivery_third_party' | 'delivery_own' | 'customer_choice';

export interface IOrderLinkItem {
  product: Types.ObjectId;
  quantity: number;
  variant?: string;
}

export interface IOrderLink {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  token: string;
  items: IOrderLinkItem[];
  deliveryType: OrderLinkDeliveryType;
  status: OrderLinkStatus;
  expiresAt: Date;
  createdBy: Types.ObjectId;
  resultingOrder?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const orderLinkItemSchema = new Schema<IOrderLinkItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
    variant: { type: String },
  },
  { _id: false }
);

const orderLinkSchema = new Schema<IOrderLink>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    token: { type: String, required: true, unique: true },
    items: { type: [orderLinkItemSchema], required: true, validate: (v: unknown[]) => v.length > 0 },
    deliveryType: {
      type: String,
      enum: ['pickup', 'delivery_third_party', 'delivery_own', 'customer_choice'],
      default: 'customer_choice',
    },
    status: { type: String, enum: ['pending', 'used', 'expired', 'cancelled'], default: 'pending' },
    expiresAt: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    resultingOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
  },
  { timestamps: true }
);

orderLinkSchema.index({ tenant: 1, status: 1 });

export const OrderLink = model<IOrderLink>('OrderLink', orderLinkSchema);
