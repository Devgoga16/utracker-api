import { Schema, model, Types, Document } from 'mongoose';

export type CampaignStatus = 'draft' | 'active' | 'ended' | 'cancelled';

export interface ICampaignItem {
  product: Types.ObjectId;
  name: string;        // snapshot
  price: number;       // snapshot
  imageUrl?: string;   // snapshot of first image
  stock: number;       // campaign-specific limit
  sold: number;        // units ordered so far
}

export type CampaignDeliveryType = 'pickup' | 'delivery_own';

export interface ICampaignSchedule {
  franjas: ('morning' | 'afternoon' | 'evening')[];
}

export interface ICampaign extends Document {
  tenant: Types.ObjectId;
  token: string;
  name: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  items: ICampaignItem[];
  deliveryTypes: CampaignDeliveryType[];
  schedule?: ICampaignSchedule;
  status: CampaignStatus;
  createdAt: Date;
  updatedAt: Date;
}

const campaignItemSchema = new Schema<ICampaignItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    imageUrl: String,
    stock: { type: Number, required: true, min: 1 },
    sold: { type: Number, default: 0 },
  },
  { _id: false },
);

const campaignSchema = new Schema<ICampaign>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    token: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: String,
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    items: { type: [campaignItemSchema], required: true },
    deliveryTypes: {
      type: [String],
      enum: ['pickup', 'delivery_own'],
      default: ['pickup'],
    },
    schedule: {
      type: new Schema<ICampaignSchedule>(
        { franjas: [{ type: String, enum: ['morning', 'afternoon', 'evening'] }] },
        { _id: false },
      ),
    },
    status: {
      type: String,
      enum: ['draft', 'active', 'ended', 'cancelled'],
      default: 'draft',
    },
  },
  { timestamps: true },
);

export const Campaign = model<ICampaign>('Campaign', campaignSchema);
