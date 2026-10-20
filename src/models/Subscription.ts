import { Schema, model, Types } from 'mongoose';
import { FeatureMap } from '../config/features.catalog';

export type SubscriptionStatus = 'trial' | 'active' | 'suspended';

/**
 * El estado que se muestra y con el que se decide, que no siempre es el guardado.
 *
 * 'expired' no se almacena nunca: se deduce de la fecha en cada consulta. Un
 * estado guardado que depende del paso del tiempo exige un proceso que lo
 * actualice, y ese proceso es justo lo que no hay.
 */
export type EffectiveStatus = SubscriptionStatus | 'expired';

export interface ISubscription {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  plan: Types.ObjectId;
  status: SubscriptionStatus;
  expiresAt?: Date;
  assignedBy?: Types.ObjectId;
  notes?: string;
  /**
   * Excepciones solo para este negocio: reemplazan el valor del plan.
   *
   * Sirven para extender un límite o regalar una funcionalidad sin inventar un
   * plan nuevo por cada acuerdo puntual. Quitar una excepción es mandar `null`
   * para esa clave.
   */
  overrides?: FeatureMap;
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
    // Mixed: igual que en el plan, las claves las valida el controlador.
    overrides: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true }
);

export const Subscription = model<ISubscription>('Subscription', subscriptionSchema);
