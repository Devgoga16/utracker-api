import { Schema, model, Types } from 'mongoose';
import { FeatureMap } from '../config/features.catalog';

/**
 * Un plan es un documento, no código.
 *
 * Sus funcionalidades son un mapa libre validado contra el catálogo
 * (`config/features.catalog.ts`): el schema no las enumera a propósito, porque
 * cada vez que lo hacía había que tocar Mongoose para agregar una clave y los
 * planes viejos quedaban sin el campo.
 */
export interface IPlan {
  _id: Types.ObjectId;
  /** Identificador estable en minúsculas ("emprende", "negocio"). No se cambia. */
  code: string;
  name: string;
  description?: string;
  /** Precio mensual en soles. 0 = sin costo. */
  price: number;
  /** Precio del año completo, ya con el descuento aplicado. Opcional. */
  priceYearly?: number;
  features: FeatureMap;
  /** Si aparece en la página de precios. */
  isPublic: boolean;
  /** Si se puede contratar. Uno inactivo sigue valiendo para quien ya lo tiene. */
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<IPlan>(
  {
    /**
     * `sparse` porque los planes creados antes de este campo no lo tienen y un
     * índice único normal los tomaría a todos como duplicados de null. El
     * script `migrate:plans` los rellena.
     */
    code: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    price: { type: Number, required: true, default: 0, min: 0 },
    priceYearly: { type: Number, min: 0 },
    // Mixed: las claves las valida el controlador contra el catálogo.
    features: { type: Schema.Types.Mixed, default: () => ({}) },
    isPublic: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

planSchema.index({ sortOrder: 1, price: 1 });

export const Plan = model<IPlan>('Plan', planSchema);

/** "Plan Negocio 2026" -> "plan-negocio-2026" */
export function planCodeFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'plan'
  );
}

export const PLAN_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/;
