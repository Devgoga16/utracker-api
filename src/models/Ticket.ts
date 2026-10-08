import { Schema, model, Types } from 'mongoose';
import { randomBytes } from 'crypto';

export type TicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketCategory = 'error' | 'question' | 'billing' | 'feature' | 'other';

export const TICKET_STATUSES: TicketStatus[] = [
  'open',
  'in_progress',
  'waiting_customer',
  'resolved',
  'closed',
];
export const TICKET_PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];
export const TICKET_CATEGORIES: TicketCategory[] = [
  'error',
  'question',
  'billing',
  'feature',
  'other',
];

export interface ITicketMessage {
  author?: Types.ObjectId;
  /** Se congela el nombre: si el usuario se va, el hilo sigue teniendo sentido. */
  authorName: string;
  /** true = lo escribió soporte; false = el negocio. Define de qué lado del hilo se dibuja. */
  fromSupport: boolean;
  body: string;
  attachments?: string[];
  createdAt: Date;
}

export interface ITicket {
  _id: Types.ObjectId;
  /** "TK-4F2A91": corto, pronunciable por teléfono. */
  code: string;
  /** Opcional: un superadmin puede abrir un ticket sin negocio de por medio. */
  tenant?: Types.ObjectId;
  createdBy?: Types.ObjectId;
  createdByName: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo?: Types.ObjectId;
  messages: ITicketMessage[];
  /**
   * Lo que el navegador sabía en el momento del error.
   *
   * Es la diferencia entre "no me funciona" y un reporte accionable, y por eso
   * se arma solo: nadie copia a mano un stack ni un user agent.
   */
  context?: {
    url?: string;
    userAgent?: string;
    appVersion?: string;
    /** `ref` del SystemLog correspondiente, cuando el error pasó por la API. */
    logRef?: string;
    /** Últimas fallas que el front juntó antes de abrir el ticket. */
    recentErrors?: string[];
  };
  /** Para marcar en rojo lo que espera respuesta, de cada lado. */
  unreadForSupport: boolean;
  unreadForTenant: boolean;
  lastMessageAt: Date;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function newTicketCode(): string {
  return `TK-${randomBytes(3).toString('hex').toUpperCase()}`;
}

const messageSchema = new Schema<ITicketMessage>(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User' },
    authorName: { type: String, required: true },
    fromSupport: { type: Boolean, default: false },
    body: { type: String, required: true, trim: true },
    attachments: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ticketSchema = new Schema<ITicket>(
  {
    code: { type: String, required: true, unique: true, default: newTicketCode },
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, required: true },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, enum: TICKET_CATEGORIES, default: 'question' },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'normal' },
    status: { type: String, enum: TICKET_STATUSES, default: 'open' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    messages: { type: [messageSchema], default: [] },
    context: {
      type: new Schema(
        {
          url: { type: String },
          userAgent: { type: String },
          appVersion: { type: String },
          logRef: { type: String },
          recentErrors: { type: [String], default: [] },
        },
        { _id: false },
      ),
    },
    unreadForSupport: { type: Boolean, default: true },
    unreadForTenant: { type: Boolean, default: false },
    lastMessageAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
  },
  { timestamps: true },
);

ticketSchema.index({ tenant: 1, createdAt: -1 });
ticketSchema.index({ status: 1, lastMessageAt: -1 });

export const Ticket = model<ITicket>('Ticket', ticketSchema);
