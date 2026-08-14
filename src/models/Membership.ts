import { Schema, model, Types } from 'mongoose';

export type MembershipRole = 'owner' | 'admin' | 'staff' | 'driver';

export interface IMembership {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  user: Types.ObjectId;
  role: MembershipRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const membershipSchema = new Schema<IMembership>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'admin', 'staff', 'driver'], required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

membershipSchema.index({ tenant: 1, user: 1 }, { unique: true });

export const Membership = model<IMembership>('Membership', membershipSchema);
