import { Schema, model, Types } from 'mongoose';
import { MembershipRole } from './Membership';

export type WorkflowKind = 'fulfillment' | 'payment';

export interface IWorkflowState {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  kind: WorkflowKind;
  name: string;
  color: string;
  icon?: string;
  position: number;
  isInitial: boolean;
  isFinal: boolean;
  isCancellation: boolean;
  notifyCustomer: boolean;
  vibrant: boolean;
  requiresLink: boolean;
  deductsStock: boolean;
  /**
   * Tipos de entrega a los que aplica este estado. Vacio = a todos.
   *
   * Sirve para que "En camino" no aparezca en un pedido de recojo en tienda,
   * ni en el panel ni en el seguimiento del cliente. Vacio por defecto para
   * que los workflows que ya existen sigan comportandose igual.
   */
  appliesTo: ('pickup' | 'delivery_third_party' | 'delivery_own')[];
  allowedRoles: MembershipRole[];
  createdAt: Date;
  updatedAt: Date;
}

const workflowStateSchema = new Schema<IWorkflowState>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    kind: { type: String, enum: ['fulfillment', 'payment'], required: true },
    name: { type: String, required: true, trim: true },
    color: { type: String, default: '#64748b' },
    icon: { type: String },
    position: { type: Number, required: true },
    isInitial: { type: Boolean, default: false },
    isFinal: { type: Boolean, default: false },
    isCancellation: { type: Boolean, default: false },
    notifyCustomer: { type: Boolean, default: false },
    vibrant: { type: Boolean, default: false },
    requiresLink: { type: Boolean, default: false },
    deductsStock: { type: Boolean, default: false },
    appliesTo: {
      type: [String],
      enum: ['pickup', 'delivery_third_party', 'delivery_own'],
      default: [],
    },
    allowedRoles: {
      type: [String],
      enum: ['owner', 'admin', 'staff', 'driver'],
      default: ['owner', 'admin'],
    },
  },
  { timestamps: true }
);

workflowStateSchema.index({ tenant: 1, kind: 1, position: 1 });

export const WorkflowState = model<IWorkflowState>('WorkflowState', workflowStateSchema);
