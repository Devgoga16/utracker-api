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

/**
 * Valores que este producto tiene para un filtro configurable.
 * Es una lista porque un mismo producto puede venir, por ejemplo, en varias
 * tallas; al filtrar basta con que coincida uno.
 */
export interface IProductAttribute {
  filter: Types.ObjectId;
  values: string[];
}

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
  attributes: IProductAttribute[];
  variants: IProductVariant[];
  /**
   * Dias que toma tenerlo listo. 0 = disponible para recojo inmediato.
   * Fija la fecha mas temprana que el cliente puede elegir al pedirlo.
   */
  preparationDays: number;
  /** Si al pedirlo hay que dejar un adelanto antes de que el negocio lo prepare. */
  requiresAdvance: boolean;
  /** 'percent' = porcentaje del subtotal de la linea; 'fixed' = soles por unidad. */
  advanceType: 'fixed' | 'percent';
  advanceValue: number;
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

const attributeSchema = new Schema<IProductAttribute>(
  {
    filter: { type: Schema.Types.ObjectId, ref: 'ProductFilter', required: true },
    values: { type: [String], default: [] },
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
    attributes: { type: [attributeSchema], default: [] },
    variants: { type: [variantSchema], default: [] },
    preparationDays: { type: Number, default: 0, min: 0 },
    requiresAdvance: { type: Boolean, default: false },
    advanceType: { type: String, enum: ['fixed', 'percent'], default: 'percent' },
    advanceValue: { type: Number, default: 50, min: 0 },
    stock: { type: Number },
    trackStock: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ tenant: 1, name: 1 });

export const Product = model<IProduct>('Product', productSchema);
