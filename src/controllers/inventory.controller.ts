import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Product } from '../models/Product';
import { StockMovement } from '../models/StockMovement';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/** Products with trackStock:true for the active tenant. */
export const listInventory = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const products = await Product.find({
    tenant: req.auth.tenantId,
    trackStock: true,
    isActive: true,
  }).sort({ name: 1 });
  res.json({ products });
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
