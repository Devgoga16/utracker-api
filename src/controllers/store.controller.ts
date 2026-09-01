import { Request, Response } from 'express';
import { Tenant } from '../models/Tenant';
import { Product } from '../models/Product';
import { Campaign } from '../models/Campaign';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

export const getStoreCatalog = asyncHandler(async (req: Request, res: Response) => {
  // Endpoint publico: solo los campos que el cliente necesita ver.
  const tenant = await Tenant.findOne({ slug: req.params.slug, isActive: true })
    .select('name slug logoUrl phone brandColor schedule')
    .lean();
  if (!tenant) throw ApiError.notFound('Store not found');

  const products = await Product.find({ tenant: tenant._id, isActive: true })
    .sort({ createdAt: -1 })
    .lean();

  // Include campaigns that are active or upcoming (not ended/cancelled)
  const now = new Date();
  const campaigns = await Campaign.find({
    tenant: tenant._id,
    status: { $in: ['active', 'draft'] },
    endDate: { $gt: now },
  })
    .sort({ startDate: 1 })
    .lean();

  res.json({ tenant, products, campaigns });
});
