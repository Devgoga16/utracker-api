import { Request, Response } from 'express';
import { Order } from '../models/Order';
import { WorkflowState } from '../models/WorkflowState';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

const isDate = (v?: string) => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

/** "2026-10-20" + 1 día, sin pasar por zonas horarias. */
function nextDay(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

/** Lo que falta cobrar de un pedido, con lo confirmado y lo devuelto. */
function owed(order: {
  totalAmount: number;
  payments: { amount: number; validated?: boolean }[];
  refunds?: { amount: number }[];
}) {
  const paid = order.payments.reduce((s, p) => (p.validated === false ? s : s + p.amount), 0);
  const refunded = (order.refunds ?? []).reduce((s, r) => s + r.amount, 0);
  return Math.max(0, Math.round((order.totalAmount - paid + refunded) * 100) / 100);
}

/**
 * GET /orders/today?date=YYYY-MM-DD — todo lo que pide atención hoy.
 *
 * La fecha la manda el navegador: "hoy" es el día de quien mira, no el del
 * servidor, que corre en UTC y a las 7 p. m. de Lima ya está en mañana.
 *
 * Las listas no se pisan: un pedido está atrasado, es de hoy o es de mañana.
 * Los comprobantes por validar van aparte porque piden otra acción (mirar el
 * Yape), aunque el pedido también aparezca en su día.
 *
 * El repartidor solo ve entregas: los pedidos de recojo no le tocan.
 */
export const todayOrders = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const tenant = req.auth.tenantId;
  const date = String(req.query.date ?? '');
  if (!isDate(date)) throw ApiError.badRequest('Indica date con formato YYYY-MM-DD');
  const tomorrow = nextDay(date);

  const closed = await WorkflowState.find({
    tenant,
    kind: 'fulfillment',
    $or: [{ isFinal: true }, { isCancellation: true }],
  }).select('_id isCancellation');
  const closedIds = closed.map((s) => s._id);
  const cancelledIds = closed.filter((s) => s.isCancellation).map((s) => s._id);

  const base: Record<string, unknown> = { tenant, createdVia: { $ne: 'pos' } };
  if (req.auth.role === 'driver') base.type = { $ne: 'pickup' };

  const open = { ...base, fulfillmentState: { $nin: closedIds } };
  const populate = 'customer fulfillmentState paymentState';

  const [overdue, today, upcoming, unscheduled, proofs] = await Promise.all([
    Order.find({ ...open, 'scheduledFor.date': { $lt: date } })
      .sort({ 'scheduledFor.date': 1 })
      .limit(100)
      .populate(populate),
    Order.find({ ...open, 'scheduledFor.date': date })
      .sort({ createdAt: 1 })
      .limit(200)
      .populate(populate),
    Order.find({ ...open, 'scheduledFor.date': tomorrow })
      .sort({ createdAt: 1 })
      .limit(100)
      .populate(populate),
    Order.find({ ...open, scheduledFor: { $exists: false } })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate(populate),
    // Comprobantes sin revisar, de pedidos que no se cancelaron.
    Order.find({
      ...base,
      fulfillmentState: { $nin: cancelledIds },
      payments: { $elemMatch: { validated: false } },
    })
      .sort({ updatedAt: -1 })
      .limit(50)
      .populate(populate),
  ]);

  // Lo que hay que cobrar al entregar: lo atrasado y lo de hoy.
  const toCollect = [...overdue, ...today].reduce((s, o) => s + owed(o), 0);

  res.json({
    date,
    tomorrow,
    overdue,
    today,
    tomorrowOrders: upcoming,
    unscheduled,
    proofs,
    toCollect: Math.round(toCollect * 100) / 100,
  });
});
