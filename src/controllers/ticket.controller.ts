import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import {
  ITicket,
  Ticket,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '../models/Ticket';
import { Tenant } from '../models/Tenant';
import { User } from '../models/User';
import { env } from '../config/env';
import { logEvent } from '../services/systemLog';
import { sendWhatsappMessage, sessionForTenant } from '../services/whatsapp';

/** Los estados que siguen pidiendo atención de soporte. */
const OPEN_STATUSES: TicketStatus[] = ['open', 'in_progress', 'waiting_customer'];

async function authorName(userId?: string): Promise<string> {
  if (!userId) return 'Usuario';
  const user = await User.findById(userId).select('name email').lean();
  return user?.name ?? user?.email ?? 'Usuario';
}

/**
 * Le avisa al negocio por WhatsApp que soporte respondió su ticket.
 *
 * Nadie vive mirando el portal de tickets: sin este aviso el hilo se contesta
 * y el dueño se entera días después, cuando vuelve a entrar a reclamar.
 */
async function notifyTenantOfReply(ticket: ITicket, preview: string) {
  if (!ticket.tenant) return;

  const tenant = await Tenant.findById(ticket.tenant).select('name phone').lean();
  if (!tenant?.phone) return;

  const session = await sessionForTenant(ticket.tenant);
  const url = `${env.frontendUrl}/support/${ticket._id}`;
  const body = preview.length > 220 ? `${preview.slice(0, 220)}…` : preview;

  void sendWhatsappMessage(
    tenant.phone,
    [
      `*Soporte uTracker* respondió tu ticket ${ticket.code}`,
      '',
      `_${ticket.subject}_`,
      '',
      body,
      '',
      `Seguí la conversación acá: ${url}`,
    ].join('\n'),
    session,
  );
}

function pickEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/* ══════════════════════ Lado del negocio ══════════════════════ */

// GET /tickets
export const listMyTickets = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const tickets = await Ticket.find({ tenant: req.auth.tenantId })
    .select('-messages')
    .sort({ lastMessageAt: -1 })
    .limit(200)
    .lean();

  res.json(tickets);
});

// POST /tickets
export const createTicket = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const { subject, body, category, priority, context } = req.body as {
    subject?: string;
    body?: string;
    category?: TicketCategory;
    priority?: TicketPriority;
    context?: ITicket['context'];
  };

  if (!subject?.trim()) throw ApiError.badRequest('Contanos en una línea de qué se trata');
  if (!body?.trim()) throw ApiError.badRequest('Describí el problema para poder ayudarte');

  const name = await authorName(req.auth.userId);
  const now = new Date();

  const ticket = await Ticket.create({
    tenant: req.auth.tenantId,
    createdBy: req.auth.userId,
    createdByName: name,
    subject: subject.trim().slice(0, 160),
    category: pickEnum(category, TICKET_CATEGORIES, 'question'),
    // La prioridad definitiva la pone soporte: lo que manda el negocio es una señal.
    priority: pickEnum(priority, TICKET_PRIORITIES, 'normal'),
    status: 'open',
    messages: [
      {
        author: req.auth.userId,
        authorName: name,
        fromSupport: false,
        body: body.trim(),
        createdAt: now,
      },
    ],
    context: context ?? undefined,
    unreadForSupport: true,
    unreadForTenant: false,
    lastMessageAt: now,
  });

  logEvent({
    level: 'info',
    source: 'web',
    message: `Ticket ${ticket.code} abierto: ${ticket.subject}`,
    action: 'ticket:create',
    tenant: req.auth.tenantId,
    user: req.auth.userId,
    context: { code: ticket.code, category: ticket.category, logRef: context?.logRef },
  });

  res.status(201).json(ticket);
});

/** Carga el ticket exigiendo que pertenezca a este negocio. */
async function ownTicket(req: Request) {
  const ticket = await Ticket.findOne({ _id: req.params.id, tenant: req.auth?.tenantId });
  if (!ticket) throw ApiError.notFound('Ticket no encontrado');
  return ticket;
}

// GET /tickets/:id
export const getMyTicket = asyncHandler(async (req: Request, res: Response) => {
  const ticket = await ownTicket(req);

  if (ticket.unreadForTenant) {
    ticket.unreadForTenant = false;
    await ticket.save();
  }

  res.json(ticket);
});

// POST /tickets/:id/messages
export const replyToMyTicket = asyncHandler(async (req: Request, res: Response) => {
  const ticket = await ownTicket(req);
  const { body } = req.body as { body?: string };
  if (!body?.trim()) throw ApiError.badRequest('Escribí tu respuesta');

  const name = await authorName(req.auth!.userId);
  const now = new Date();

  ticket.messages.push({
    author: new Types.ObjectId(req.auth!.userId),
    authorName: name,
    fromSupport: false,
    body: body.trim(),
    createdAt: now,
  });
  ticket.unreadForSupport = true;
  ticket.lastMessageAt = now;

  // Contestar un ticket cerrado lo reabre: si el problema volvió, es el mismo problema.
  if (ticket.status === 'resolved' || ticket.status === 'closed') ticket.status = 'open';
  else if (ticket.status === 'waiting_customer') ticket.status = 'in_progress';

  await ticket.save();
  res.json(ticket);
});

// PATCH /tickets/:id/close
export const closeMyTicket = asyncHandler(async (req: Request, res: Response) => {
  const ticket = await ownTicket(req);
  ticket.status = 'closed';
  ticket.resolvedAt = new Date();
  ticket.unreadForSupport = false;
  await ticket.save();
  res.json(ticket);
});

/* ══════════════════════ Lado de soporte ══════════════════════ */

// GET /superadmin/tickets
export const listAllTickets = asyncHandler(async (req: Request, res: Response) => {
  const { status, priority, category, tenantId, q, scope } = req.query as Record<string, string>;

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status as TicketStatus;
  // Una bandeja arranca en "lo que falta atender", no en todo lo que existió.
  else if (scope !== 'all') filter.status = { $in: OPEN_STATUSES };
  if (priority) filter.priority = priority as TicketPriority;
  if (category) filter.category = category as TicketCategory;
  if (tenantId) filter.tenant = new Types.ObjectId(tenantId);
  if (q?.trim()) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ subject: rx }, { code: rx }, { createdByName: rx }];
  }

  const tickets = await Ticket.find(filter)
    .select('-messages')
    .populate('tenant', 'name slug')
    .populate('assignedTo', 'name')
    .sort({ lastMessageAt: -1 })
    .limit(300)
    .lean();

  res.json(tickets);
});

// GET /superadmin/tickets/stats
export const ticketStats = asyncHandler(async (_req: Request, res: Response) => {
  const rows = await Ticket.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);

  const byStatus: Record<string, number> = {};
  for (const s of TICKET_STATUSES) byStatus[s] = 0;
  for (const row of rows) byStatus[row._id] = row.count;

  const [unread, urgent] = await Promise.all([
    Ticket.countDocuments({ unreadForSupport: true, status: { $in: OPEN_STATUSES } }),
    Ticket.countDocuments({ priority: 'urgent', status: { $in: OPEN_STATUSES } }),
  ]);

  res.json({
    byStatus,
    unread,
    urgent,
    open: OPEN_STATUSES.reduce((sum, key) => sum + byStatus[key], 0),
  });
});

// GET /superadmin/tickets/:id
export const getTicketAsSupport = asyncHandler(async (req: Request, res: Response) => {
  const ticket = await Ticket.findById(req.params.id)
    .populate('tenant', 'name slug phone')
    .populate('assignedTo', 'name');
  if (!ticket) throw ApiError.notFound('Ticket no encontrado');

  if (ticket.unreadForSupport) {
    ticket.unreadForSupport = false;
    await ticket.save();
  }

  res.json(ticket);
});

// POST /superadmin/tickets/:id/messages
export const replyAsSupport = asyncHandler(async (req: Request, res: Response) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) throw ApiError.notFound('Ticket no encontrado');

  const { body, status, notify } = req.body as {
    body?: string;
    status?: TicketStatus;
    notify?: boolean;
  };
  if (!body?.trim()) throw ApiError.badRequest('Escribí la respuesta');

  const name = await authorName(req.auth!.userId);
  const now = new Date();

  ticket.messages.push({
    author: new Types.ObjectId(req.auth!.userId),
    authorName: name,
    fromSupport: true,
    body: body.trim(),
    createdAt: now,
  });
  ticket.unreadForTenant = true;
  ticket.unreadForSupport = false;
  ticket.lastMessageAt = now;
  ticket.status = pickEnum(status, TICKET_STATUSES, 'in_progress');
  if (ticket.status === 'resolved' || ticket.status === 'closed') ticket.resolvedAt = now;
  // Quien contesta primero se queda el ticket: evita dos respuestas en paralelo.
  if (!ticket.assignedTo) ticket.assignedTo = new Types.ObjectId(req.auth!.userId);

  await ticket.save();

  if (notify !== false) await notifyTenantOfReply(ticket, body.trim());

  res.json(ticket);
});

// PATCH /superadmin/tickets/:id
export const updateTicketAsSupport = asyncHandler(async (req: Request, res: Response) => {
  const { status, priority, assignToMe } = req.body as {
    status?: TicketStatus;
    priority?: TicketPriority;
    assignToMe?: boolean;
  };

  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) throw ApiError.notFound('Ticket no encontrado');

  if (status && TICKET_STATUSES.includes(status)) {
    ticket.status = status;
    if (status === 'resolved' || status === 'closed') ticket.resolvedAt = new Date();
  }
  if (priority && TICKET_PRIORITIES.includes(priority)) ticket.priority = priority;
  if (assignToMe) ticket.assignedTo = new Types.ObjectId(req.auth!.userId);

  await ticket.save();
  res.json(ticket);
});
