import { Schema, model, Types } from 'mongoose';

export type SubscriptionStatus = 'trial' | 'active' | 'suspended';

export interface ISubscription {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  plan: Types.ObjectId;
  status: SubscriptionStatus;
  expiresAt?: Date;
  assignedBy?: Types.ObjectId;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true },
    plan: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    status: { type: String, enum: ['trial', 'active', 'suspended'], default: 'trial' },
    expiresAt: { type: Date },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

export const Subscription = model<ISubscription>('Subscription', subscriptionSchema);
