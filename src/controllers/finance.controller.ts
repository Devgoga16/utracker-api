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

  const match: Record<string, unknown> = { tenant: tenantId };

  Object.assign(match, dateMatch(dateBasis, from, to));

  if (fulfillmentStateId) match.fulfillmentState = new Types.ObjectId(fulfillmentStateId);
  if (paymentStateId) match.paymentState = new Types.ObjectId(paymentStateId);
  if (type) match.type = type;
  if (productId) match['items.product'] = new Types.ObjectId(productId);

  const [summary] = await Order.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: '$totalAmount' },
              /**
               * Solo pagos confirmados. Un comprobante que el cliente subio y
               * nadie reviso no es dinero en caja: contarlo inflaria los
               * ingresos con plata que podria no haber llegado.
               */
              totalCollected: {
                $sum: {
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
              },
              orderCount: { $sum: 1 },
            },
          },
        ],
        topProducts: [
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
          {
            $project: {
              _id: 0,
              productId: '$_id',
              name: 1,
              revenue: 1,
              quantity: 1,
            },
          },
        ],
      },
    },
  ]);

  const t = summary?.totals?.[0] ?? { totalRevenue: 0, totalCollected: 0, orderCount: 0 };
  const totalRevenue: number = t.totalRevenue ?? 0;
  const totalCollected: number = t.totalCollected ?? 0;

  res.json({
    totalRevenue,
    totalCollected,
    totalPending: totalRevenue - totalCollected,
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

  const match: Record<string, unknown> = { tenant: tenantId };

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
