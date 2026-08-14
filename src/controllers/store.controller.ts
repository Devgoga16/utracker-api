import { Request, Response } from 'express';
import { Tenant } from '../models/Tenant';
import { Product } from '../models/Product';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

export const getStoreCatalog = asyncHandler(async (req: Request, res: Response) => {
  const tenant = await Tenant.findOne({ slug: req.params.slug, isActive: true }).lean();
  if (!tenant) throw ApiError.notFound('Store not found');

  const products = await Product.find({ tenant: tenant._id, isActive: true })
    .sort({ createdAt: -1 })
    .lean();

  res.json({ tenant, products });
});
