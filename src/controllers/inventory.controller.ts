import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Product } from '../models/Product';
import { StockMovement } from '../models/StockMovement';
import { Tenant } from '../models/Tenant';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { checkLowStock } from '../services/stockAlerts';

/** Ventana para medir el ritmo de venta. Más corta reacciona a picos puntuales. */
const VELOCITY_DAYS = 30;

/**
 * Inventario con proyección de agotamiento.
 *
 * El ritmo sale de los movimientos reales de los últimos 30 días, no de un
 * promedio configurado a mano: el dueño no tiene que estimar nada y la cuenta
 * se ajusta sola cuando cambia la demanda.
 */
export const listInventory = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const tenantId = req.auth.tenantId;

  const since = new Date();
  since.setDate(since.getDate() - VELOCITY_DAYS);

  const [products, tenant, sold] = await Promise.all([
    Product.find({ tenant: tenantId, trackStock: true, isActive: true }).sort({ name: 1 }).lean(),
    Tenant.findById(tenantId).select('lowStockThreshold').lean(),
    // Solo salidas por venta: un ajuste manual no es demanda.
    StockMovement.aggregate<{ _id: Types.ObjectId; units: number }>([
      {
        $match: {
          tenant: new Types.ObjectId(tenantId),
          reason: 'order',
          delta: { $lt: 0 },
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: '$product', units: { $sum: { $abs: '$delta' } } } },
    ]),
  ]);

  const unitsByProduct = new Map(sold.map((s) => [s._id.toString(), s.units]));
  const tenantThreshold = tenant?.lowStockThreshold ?? 5;

  const enriched = products.map((p) => {
    const units = unitsByProduct.get(p._id.toString()) ?? 0;
    const perDay = units / VELOCITY_DAYS;
    const stock = p.stock ?? 0;

    return {
      ...p,
      threshold: p.lowStockThreshold ?? tenantThreshold,
      soldLastDays: units,
      /** Sin ventas en la ventana no hay ritmo que proyectar. */
      daysLeft: perDay > 0 && stock > 0 ? Math.floor(stock / perDay) : null,
      perDay: Math.round(perDay * 100) / 100,
    };
  });

  res.json({ products: enriched, velocityDays: VELOCITY_DAYS });
});

/** Manual stock adjustment: positive delta = entry, negative = exit. */
export const adjustStock = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const { delta, note } = req.body as { delta?: number; note?: string };
  if (delta === undefined || delta === 0) throw ApiError.badRequest('delta must be a non-zero number');

  const product = await Product.findOne({
    _id: req.params.id,
    tenant: req.auth.tenantId,
    trackStock: true,
  });
  if (!product) throw ApiError.notFound('Producto no encontrado o no tiene control de stock');

  const currentStock = product.stock ?? 0;
  const newStock = currentStock + delta;

  await Promise.all([
    Product.updateOne({ _id: product._id }, { $set: { stock: newStock } }),
    StockMovement.create({
      tenant: req.auth.tenantId,
      product: product._id,
      delta,
      reason: 'adjustment',
      note: note?.trim() || undefined,
      createdBy: req.auth.userId ? new Types.ObjectId(req.auth.userId) : undefined,
    }),
  ]);

  // Un ajuste a la baja también puede dejar el producto en rojo.
  if (delta < 0) {
    void checkLowStock(req.auth.tenantId, [
      { productId: product._id.toString(), soldUnits: -delta },
    ]);
  }

  res.json({ stock: newStock });
});

/** Movement history for a single product. */
export const listMovements = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const product = await Product.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!product) throw ApiError.notFound('Producto no encontrado');

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const movements = await StockMovement.find({
    tenant: req.auth.tenantId,
    product: product._id,
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('order', 'trackingToken createdAt')
    .populate('createdBy', 'name email');

  res.json({ movements });
});
