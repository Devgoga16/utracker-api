import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ISystemLog, SystemLog } from '../models/SystemLog';
import { SupportAccess } from '../models/SupportAccess';
import { Ticket } from '../models/Ticket';
import { Tenant } from '../models/Tenant';
import { Membership } from '../models/Membership';
import { Subscription } from '../models/Subscription';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { Customer } from '../models/Customer';
import { Campaign } from '../models/Campaign';
import { WorkflowState } from '../models/WorkflowState';
import { logEvent, logRetentionDays } from '../services/systemLog';
import { isSharedBotConfigured } from '../services/whatsapp';

/* ══════════════════════ Visor de logs ══════════════════════ */

// GET /superadmin/logs
export const listLogs = asyncHandler(async (req: Request, res: Response) => {
  const { level, source, tenantId, q, ref, from, to, limit, skip } = req.query as Record<
    string,
    string
  >;

  const filter: Record<string, unknown> = {};
  if (level) filter.level = level as ISystemLog['level'];
  if (source) filter.source = source as ISystemLog['source'];
  if (tenantId) filter.tenant = new Types.ObjectId(tenantId);
  if (ref) filter.ref = ref.trim().toUpperCase();
  if (q?.trim()) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ message: rx }, { action: rx }];
  }
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) range.$gte = new Date(from);
    if (to) {
      // El `to` que manda el front es un día, y un día incluye su último minuto.
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
    filter.createdAt = range;
  }

  const take = Math.min(Number(limit) || 60, 200);
  const offset = Math.max(Number(skip) || 0, 0);

  const [logs, total] = await Promise.all([
    SystemLog.find(filter)
      .populate('tenant', 'name slug')
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(take)
      .lean(),
    SystemLog.countDocuments(filter),
  ]);

  res.json({ logs, total, limit: take, skip: offset, retentionDays: logRetentionDays });
});

// GET /superadmin/logs/stats
export const logStats = asyncHandler(async (_req: Request, res: Response) => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [byLevel, errors7d, topMessages] = await Promise.all([
    SystemLog.aggregate([
      { $match: { createdAt: { $gte: since24h } } },
      { $group: { _id: '$level', count: { $sum: 1 } } },
    ]),
    SystemLog.countDocuments({ level: 'error', createdAt: { $gte: since7d } }),
    // Lo que más se repite es casi siempre lo que hay que arreglar primero.
    SystemLog.aggregate([
      { $match: { level: 'error', createdAt: { $gte: since7d } } },
      { $group: { _id: { message: '$message', action: '$action' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),
  ]);

  const last24h: Record<string, number> = { error: 0, warn: 0, info: 0 };
  for (const row of byLevel) last24h[row._id] = row.count;

  res.json({
    last24h,
    errors7d,
    top: topMessages.map((t) => ({
      message: t._id.message,
      action: t._id.action,
      count: t.count,
    })),
    retentionDays: logRetentionDays,
  });
});

// GET /superadmin/logs/by-ref/:ref
export const getLogByRef = asyncHandler(async (req: Request, res: Response) => {
  const log = await SystemLog.findOne({ ref: String(req.params.ref).toUpperCase() })
    .populate('tenant', 'name slug')
    .populate('user', 'name email')
    .lean();
  if (!log) throw ApiError.notFound('No hay ningún log con ese código');
  res.json(log);
});

/* ══════════════════════ Reporte desde el navegador ══════════════════════ */

/**
 * POST /logs/client
 *
 * El front manda acá lo que se rompió de su lado: un render que explotó, una
 * promesa sin atrapar. Sin esto los errores del navegador no existen para
 * nadie, porque viven y mueren en la consola del usuario.
 */
export const reportClientError = asyncHandler(async (req: Request, res: Response) => {
  const { message, stack, url, userAgent, action } = req.body as Record<string, string>;
  if (!message?.trim()) throw ApiError.badRequest('message is required');

  const ref = logEvent({
    level: 'error',
    source: 'web',
    message: message.trim(),
    action: action || 'web:error',
    stack,
    tenant: req.header('X-Tenant-Id') ?? undefined,
    user: req.auth?.userId,
    context: { url, userAgent },
  });

  res.status(201).json({ ref });
});

/* ══════════════════════ Ficha técnica del negocio ══════════════════════ */

interface HealthCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

// GET /superadmin/tenants/:id/detail
export const getTenantDetail = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = new Types.ObjectId(String(req.params.id));

  const tenant = await Tenant.findById(tenantId).select('+whatsapp').lean();
  if (!tenant) throw ApiError.notFound('Negocio no encontrado');

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const [
    members,
    subscription,
    orders,
    ordersThisMonth,
    lastOrder,
    products,
    activeProducts,
    customers,
    campaigns,
    states,
    openTickets,
    recentErrors,
    accesses,
  ] = await Promise.all([
    Membership.find({ tenant: tenantId }).populate('user', 'name email isActive').lean(),
    Subscription.findOne({ tenant: tenantId }).populate('plan', 'name price features').lean(),
    Order.countDocuments({ tenant: tenantId }),
    Order.countDocuments({ tenant: tenantId, createdAt: { $gte: monthStart } }),
    Order.findOne({ tenant: tenantId }).sort({ createdAt: -1 }).select('createdAt').lean(),
    Product.countDocuments({ tenant: tenantId }),
    Product.countDocuments({ tenant: tenantId, isActive: true }),
    Customer.countDocuments({ tenant: tenantId }),
    Campaign.countDocuments({ tenant: tenantId }),
    WorkflowState.find({ tenant: tenantId }).select('kind isInitial name').lean(),
    Ticket.countDocuments({
      tenant: tenantId,
      status: { $in: ['open', 'in_progress', 'waiting_customer'] },
    }),
    SystemLog.find({ tenant: tenantId, level: 'error' })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('ref message action statusCode createdAt')
      .lean(),
    SupportAccess.find({ tenant: tenantId })
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
  ]);

  const hasInitialFulfillment = states.some((s) => s.kind === 'fulfillment' && s.isInitial);
  const hasInitialPayment = states.some((s) => s.kind === 'payment' && s.isInitial);
  const ownWhatsapp = Boolean(tenant.whatsapp?.sendUrl && tenant.whatsapp?.apiKey);

  /**
   * Las fallas de configuración que explican la mayoría de los "no me funciona".
   *
   * Son cosas que el dueño no sabe que le faltan: el sistema no se rompe, solo
   * deja de dejarlo vender, y el error aparece recién cuando un cliente intenta
   * comprar. Verlas de un vistazo evita media hora de ida y vuelta.
   */
  const health: HealthCheck[] = [
    {
      key: 'workflow',
      label: 'Workflow configurado',
      ok: hasInitialFulfillment && hasInitialPayment,
      detail:
        hasInitialFulfillment && hasInitialPayment
          ? `${states.length} estados, con inicial de entrega y de pago`
          : 'Falta un estado inicial: no se puede crear ningún pedido',
    },
    {
      key: 'phone',
      label: 'WhatsApp del negocio',
      ok: Boolean(tenant.phone),
      detail: tenant.phone
        ? `${tenant.phone} · ${ownWhatsapp ? 'sesión propia' : 'bot compartido'}`
        : 'Sin número: no recibe avisos de pedidos nuevos',
    },
    {
      key: 'bot',
      label: 'Envío de WhatsApp disponible',
      ok: ownWhatsapp || isSharedBotConfigured(),
      detail: ownWhatsapp
        ? 'Sesión propia configurada'
        : isSharedBotConfigured()
          ? 'Usa el bot compartido de uTracker'
          : 'Ni sesión propia ni bot compartido: no sale ningún mensaje',
    },
    {
      key: 'store',
      label: 'Tienda pública lista',
      ok: Boolean(tenant.deliveryTypes?.length),
      detail: tenant.deliveryTypes?.length
        ? `Acepta: ${tenant.deliveryTypes.join(', ')}`
        : 'Sin tipos de entrega: nadie puede comprar desde el catálogo',
    },
    {
      key: 'payments',
      label: 'Métodos de pago',
      ok: Boolean(tenant.paymentMethods?.length),
      detail: tenant.paymentMethods?.length
        ? tenant.paymentMethods.map((m) => m.name).join(', ')
        : 'Sin métodos de pago: no puede pedir adelantos ni comprobantes',
    },
    {
      key: 'catalog',
      label: 'Catálogo con productos activos',
      ok: activeProducts > 0,
      detail: activeProducts > 0 ? `${activeProducts} de ${products} activos` : 'Catálogo vacío',
    },
    {
      key: 'subscription',
      label: 'Suscripción vigente',
      ok: Boolean(subscription) && subscription?.status !== 'suspended',
      detail: subscription
        ? `${(subscription.plan as unknown as { name?: string })?.name ?? 'Plan'} · ${subscription.status}`
        : 'Sin suscripción asignada',
    },
  ];

  // La `apiKey` no sale nunca; alcanza saber si tiene sesión propia.
  const { whatsapp, ...safeTenant } = tenant;

  res.json({
    tenant: { ...safeTenant, whatsappMode: ownWhatsapp ? 'own' : 'shared' },
    subscription,
    members: members.map((m) => ({
      _id: m._id,
      role: m.role,
      isActive: m.isActive,
      user: m.user,
      createdAt: m.createdAt,
    })),
    counts: {
      orders,
      ordersThisMonth,
      products,
      activeProducts,
      customers,
      campaigns,
      workflowStates: states.length,
      openTickets,
    },
    lastOrderAt: lastOrder?.createdAt ?? null,
    health,
    recentErrors,
    supportAccesses: accesses,
  });
});

/* ══════════════════════ Accesos de soporte ══════════════════════ */

const MAX_ACCESS_MINUTES = 8 * 60;

// POST /superadmin/tenants/:id/support-access
export const grantSupportAccess = asyncHandler(async (req: Request, res: Response) => {
  const { reason, minutes, canWrite } = req.body as {
    reason?: string;
    minutes?: number;
    canWrite?: boolean;
  };

  if (!reason?.trim()) {
    throw ApiError.badRequest('Escribí el motivo del acceso: queda en la bitácora del negocio');
  }

  const tenant = await Tenant.findById(req.params.id).select('name').lean();
  if (!tenant) throw ApiError.notFound('Negocio no encontrado');

  // Un acceso que no vence es una llave permanente con otro nombre.
  const span = Math.min(Math.max(Number(minutes) || 60, 5), MAX_ACCESS_MINUTES);

  const access = await SupportAccess.create({
    tenant: tenant._id,
    user: req.auth!.userId,
    reason: reason.trim(),
    canWrite: Boolean(canWrite),
    expiresAt: new Date(Date.now() + span * 60 * 1000),
  });

  logEvent({
    level: 'warn',
    source: 'support',
    message: `Acceso de soporte a "${tenant.name}" (${canWrite ? 'con cambios' : 'solo lectura'}): ${reason.trim()}`,
    action: 'support:grant',
    tenant: String(tenant._id),
    user: req.auth!.userId,
    context: { minutes: span, canWrite: Boolean(canWrite), accessId: String(access._id) },
  });

  res.status(201).json(access);
});

// GET /superadmin/support-access
export const listSupportAccesses = asyncHandler(async (req: Request, res: Response) => {
  const { tenantId, mine } = req.query as Record<string, string>;

  const filter: Record<string, unknown> = {};
  if (tenantId) filter.tenant = new Types.ObjectId(tenantId);
  if (mine === '1') filter.user = new Types.ObjectId(req.auth!.userId);

  const accesses = await SupportAccess.find(filter)
    .populate('tenant', 'name slug')
    .populate('user', 'name email')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.json(accesses);
});

// DELETE /superadmin/support-access/:id
export const revokeSupportAccess = asyncHandler(async (req: Request, res: Response) => {
  const access = await SupportAccess.findById(req.params.id);
  if (!access) throw ApiError.notFound('Acceso no encontrado');

  if (!access.revokedAt) {
    access.revokedAt = new Date();
    await access.save();

    logEvent({
      level: 'info',
      source: 'support',
      message: 'Acceso de soporte revocado',
      action: 'support:revoke',
      tenant: String(access.tenant),
      user: req.auth!.userId,
      context: { accessId: String(access._id) },
    });
  }

  res.json({ ok: true, revokedAt: access.revokedAt });
});
