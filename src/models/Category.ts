import { Schema, model, Types } from 'mongoose';

export interface ICategory {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<ICategory>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

categorySchema.index({ tenant: 1, name: 1 }, { unique: true });

export const Category = model<ICategory>('Category', categorySchema);
