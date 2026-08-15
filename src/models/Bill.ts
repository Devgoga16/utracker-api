import { Schema, model, Types } from 'mongoose';

export type BillStatus = 'pending' | 'reviewing' | 'paid' | 'overdue';

export interface IBill {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  subscription: Types.ObjectId;
  period: string; // "2026-08"
  planName: string;
  amount: number;
  dueDate: Date;
  status: BillStatus;
  proofImageUrl?: string;
  proofUploadedAt?: Date;
  paidAt?: Date;
  confirmedBy?: Types.ObjectId;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const billSchema = new Schema<IBill>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    subscription: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true },
    period: { type: String, required: true }, // "YYYY-MM"
    planName: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    dueDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ['pending', 'reviewing', 'paid', 'overdue'],
      default: 'pending',
    },
    proofImageUrl: { type: String },
    proofUploadedAt: { type: Date },
    paidAt: { type: Date },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

// One bill per tenant per period — prevents duplicate generation.
billSchema.index({ tenant: 1, period: 1 }, { unique: true });
billSchema.index({ status: 1 });

export const Bill = model<IBill>('Bill', billSchema);
