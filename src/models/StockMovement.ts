import { Schema, model, Types } from 'mongoose';

export type StockMovementReason = 'order' | 'adjustment';

export interface IStockMovement {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  product: Types.ObjectId;
  order?: Types.ObjectId;
  /** Positive = stock in, negative = stock out. */
  delta: number;
  reason: StockMovementReason;
  note?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
}

const stockMovementSchema = new Schema<IStockMovement>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    delta: { type: Number, required: true },
    reason: { type: String, enum: ['order', 'adjustment'], required: true },
    note: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

stockMovementSchema.index({ tenant: 1, product: 1, createdAt: -1 });
stockMovementSchema.index({ tenant: 1, order: 1 });

export const StockMovement = model<IStockMovement>('StockMovement', stockMovementSchema);
