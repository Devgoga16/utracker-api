import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Order } from '../models/Order';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * Arma el filtro de fecha segun el eje elegido.
 *
 * Por creacion responde "cuanto vendi"; por entrega, "cuanto entregue". Un
 * pedido que entro en setiembre y se entrego en octubre pertenece a meses
 * distintos segun lo que se quiera medir, y antes solo existia el primer eje:
 * esos pedidos simplemente no aparecian donde el dueno los buscaba.
 */
function dateMatch(
  basis: string | undefined,
  from?: string,
  to?: string,
): Record<string, unknown> {
  if (!from && !to) return {};

  if (basis === 'scheduled') {
    // Se guardan como "2026-10-08": comparacion de texto, sin zonas de por medio.
    const range: Record<string, string> = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    return { 'scheduledFor.date': range };
  }

  const range: Record<string, Date> = {};
  if (from) range.$gte = new Date(from);
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    range.$lte = end;
  }
  return { createdAt: range };
}

export const getFinanceSummary = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const tenantId = new Types.ObjectId(req.auth.tenantId);

  const {
    from,
    to,
    fulfillmentStateId,
    paymentStateId,
    type,
    productId,
    dateBasis,
  } = req.query as Record<string, string | undefined>;

  /*
   * Una venta de mostrador anulada no existió: se devolvió el dinero y el
   * producto. Si contara, el total vendido subiría y aparecería como deuda.
   */
  const match: Record<string, unknown> = { tenant: tenantId, voidedAt: { $exists: false } };

  Object.assign(match, dateMatch(dateBasis, from, to));

  if (fulfillmentStateId) match.fulfillmentState = new Types.ObjectId(fulfillmentStateId);
  if (paymentStateId) match.paymentState = new Types.ObjectId(paymentStateId);
  if (type) match.type = type;
  if (productId) match['items.product'] = new Types.ObjectId(productId);

  /*
   * Por pedido: si está cancelado y cuánto dinero se quedó de verdad
   * (pagos confirmados menos devoluciones).
   *
   * Un cancelado no cuenta como vendido ni como deuda: antes sumaba al
   * facturado y aparecía como pendiente de cobro para siempre. Lo que se
   * cobró de él y no se devolvió sí cuenta como cobrado, porque está en caja.
   */
  const [summary] = await Order.aggregate([
    { $match: match },
    {
      $lookup: {
        from: 'workflowstates',
        localField: 'fulfillmentState',
        foreignField: '_id',
        as: 'fs',
      },
    },
    {
      $addFields: {
        cancelled: { $eq: [{ $first: '$fs.isCancellation' }, true] },
        kept: {
          $subtract: [
            {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ['$payments', []] },
                      cond: { $ne: ['$$this.validated', false] },
                    },
                  },
                  in: '$$this.amount',
                },
              },
            },
            { $sum: { $map: { input: { $ifNull: ['$refunds', []] }, in: '$$this.amount' } } },
          ],
        },
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: { $cond: ['$cancelled', 0, '$totalAmount'] } },
              totalCollected: { $sum: '$kept' },
              totalPending: {
                $sum: {
                  $cond: ['$cancelled', 0, { $max: [0, { $subtract: ['$totalAmount', '$kept'] }] }],
                },
              },
              orderCount: { $sum: { $cond: ['$cancelled', 0, 1] } },
            },
          },
        ],
        topProducts: [
          { $match: { cancelled: false } },
          { $unwind: '$items' },
          { $match: { 'items.product': { $exists: true, $ne: null } } },
          {
            $group: {
              _id: '$items.product',
              name: { $first: '$items.name' },
              revenue: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } },
              quantity: { $sum: '$items.quantity' },
            },
          },
          { $sort: { revenue: -1 } },
          { $limit: 5 },
          { $project: { _id: 0, productId: '$_id', name: 1, revenue: 1, quantity: 1 } },
        ],
      },
    },
  ]);

  const t = summary?.totals?.[0] ?? { totalRevenue: 0, totalCollected: 0, totalPending: 0, orderCount: 0 };
  const totalRevenue: number = t.totalRevenue ?? 0;
  const totalCollected: number = t.totalCollected ?? 0;

  res.json({
    totalRevenue,
    totalCollected,
    totalPending: t.totalPending ?? 0,
    orderCount: t.orderCount ?? 0,
    avgOrderValue: t.orderCount > 0 ? totalRevenue / t.orderCount : 0,
    topProducts: summary?.topProducts ?? [],
  });
});

export const getFinanceOrders = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const tenantId = new Types.ObjectId(req.auth.tenantId);

  const {
    from,
    to,
    fulfillmentStateId,
    paymentStateId,
    type,
    productId,
    page,
    dateBasis,
  } = req.query as Record<string, string | undefined>;

  /*
   * Una venta de mostrador anulada no existió: se devolvió el dinero y el
   * producto. Si contara, el total vendido subiría y aparecería como deuda.
   */
  const match: Record<string, unknown> = { tenant: tenantId, voidedAt: { $exists: false } };

  Object.assign(match, dateMatch(dateBasis, from, to));

  if (fulfillmentStateId) match.fulfillmentState = new Types.ObjectId(fulfillmentStateId);
  if (paymentStateId) match.paymentState = new Types.ObjectId(paymentStateId);
  if (type) match.type = type;
  if (productId) match['items.product'] = new Types.ObjectId(productId);

  const pageNum = Math.max(1, Number(page) || 1);
  const limit = 50;
  const skip = (pageNum - 1) * limit;

  const [orders, total] = await Promise.all([
    Order.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('customer', 'name phone')
      .populate('fulfillmentState', 'name color icon')
      .populate('paymentState', 'name color icon'),
    Order.countDocuments(match),
  ]);

  res.json({ orders, total, page: pageNum, pages: Math.ceil(total / limit) });
});
