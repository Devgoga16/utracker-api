import { Schema, model, Types } from 'mongoose';

/**
 * Filtro configurable del catálogo. Cada negocio define los suyos, porque
 * uTracker no sabe si vende ropa ("Talla", "Color") o helados ("Sabor").
 *
 * Es distinto de Category: la categoría parte el catálogo en secciones, el
 * filtro es un atributo transversal con el que el cliente acota lo que ve.
 */
export interface IProductFilter {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  /** "Talla", "Sabor", "Material". */
  name: string;
  /** Opciones válidas: ["S", "M", "L"]. */
  values: string[];
  /** Orden en que se muestran al cliente. */
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

const productFilterSchema = new Schema<IProductFilter>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    values: { type: [String], default: [] },
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Dos filtros con el mismo nombre en un negocio solo confunden.
productFilterSchema.index({ tenant: 1, name: 1 }, { unique: true });

export const ProductFilter = model<IProductFilter>('ProductFilter', productFilterSchema);
