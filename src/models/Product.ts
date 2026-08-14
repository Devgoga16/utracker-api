import { Schema, model, Types } from 'mongoose';

export interface IProductVariant {
  name: string;
  priceModifier: number;
}

export type CatalogKind = 'product' | 'service';

/**
 * 'quoted' means `price` is only a reference: the real one is agreed per order
 * and written into the OrderItem. Typical for services (a sign, a logo design).
 */
export type PricingMode = 'fixed' | 'quoted';

export interface IProduct {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  kind: CatalogKind;
  pricingMode: PricingMode;
  name: string;
  description?: string;
  price: number;
  images: string[];
  category?: string;
  variants: IProductVariant[];
  stock?: number;
  trackStock: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const variantSchema = new Schema<IProductVariant>(
  {
    name: { type: String, required: true },
    priceModifier: { type: Number, default: 0 },
  },
  { _id: false }
);

const productSchema = new Schema<IProduct>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    kind: { type: String, enum: ['product', 'service'], default: 'product' },
    pricingMode: { type: String, enum: ['fixed', 'quoted'], default: 'fixed' },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    price: { type: Number, required: true, min: 0 },
    images: { type: [String], default: [] },
    category: { type: String },
    variants: { type: [variantSchema], default: [] },
    stock: { type: Number },
    trackStock: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ tenant: 1, name: 1 });

export const Product = model<IProduct>('Product', productSchema);
