import { Schema, model, Types } from 'mongoose';

export interface IPlanFeatures {
  maxOrdersPerMonth: number;
  maxCatalogItems: number;
  maxMembers: number;
  maxWorkflowStates: number;
  workflowCustomization: boolean;
  publicOrderLinks: boolean;
  imageUploads: boolean;
  deliveryTypes: boolean;
  publicTracking: boolean;
  advancePayments: boolean;
  inventory: boolean;
  finances: boolean;
}

export interface IPlan {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  price: number;
  features: IPlanFeatures;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const featuresSchema = new Schema<IPlanFeatures>(
  {
    maxOrdersPerMonth: { type: Number, required: true, default: 0 },
    maxCatalogItems: { type: Number, required: true, default: 0 },
    maxMembers: { type: Number, required: true, default: 0 },
    maxWorkflowStates: { type: Number, required: true, default: 0 },
    workflowCustomization: { type: Boolean, required: true, default: false },
    publicOrderLinks: { type: Boolean, required: true, default: false },
    imageUploads: { type: Boolean, required: true, default: false },
    deliveryTypes: { type: Boolean, required: true, default: false },
    publicTracking: { type: Boolean, required: true, default: false },
    advancePayments: { type: Boolean, required: true, default: false },
    inventory: { type: Boolean, required: true, default: false },
    finances: { type: Boolean, required: true, default: false },
  },
  { _id: false }
);

const planSchema = new Schema<IPlan>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    price: { type: Number, required: true, default: 0 },
    features: { type: featuresSchema, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Plan = model<IPlan>('Plan', planSchema);
