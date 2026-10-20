import { Schema, model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { MembershipRole } from './Membership';

export type InvitationStatus = 'pending' | 'accepted' | 'cancelled' | 'expired';

/**
 * Una invitación a sumarse al equipo de un negocio.
 *
 * Viaja como link, no como correo: uTracker no manda emails, así que el dueño
 * copia el enlace y lo pasa por WhatsApp —igual que ya hace con los links de
 * pedido—. Eso define el modelo de confianza: **el token es la credencial**,
 * como en el seguimiento público. Por eso es de un solo uso, vence, y se puede
 * cancelar antes de que alguien lo use.
 *
 * El email no es para notificar: es la identidad con la que esa persona va a
 * entrar, porque es la clave única de `User`.
 */
export interface IInvitation {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  /** Con quién va a quedar asociada la cuenta. En minúsculas. */
  email: string;
  role: MembershipRole;
  token: string;
  /** Opcional, solo para mandarle el link por WhatsApp. */
  phone?: string;
  invitedBy?: Types.ObjectId;
  status: InvitationStatus;
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export function newInvitationToken(): string {
  return randomBytes(24).toString('hex');
}

const invitationSchema = new Schema<IInvitation>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ['owner', 'admin', 'staff', 'driver'], required: true },
    token: { type: String, required: true, unique: true, default: newInvitationToken },
    phone: { type: String, trim: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'cancelled', 'expired'],
      default: 'pending',
    },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date },
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// Las aceptadas y canceladas se conservan: son el registro de quién sumó a quién.
invitationSchema.index({ tenant: 1, status: 1, createdAt: -1 });
invitationSchema.index({ tenant: 1, email: 1, status: 1 });

export const Invitation = model<IInvitation>('Invitation', invitationSchema);
