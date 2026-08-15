import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/auth';
import { Subscription } from '../models/Subscription';

export const subscriptionRoutes = Router();

subscriptionRoutes.get(
  '/me',
  requireAuth,
  requireTenant,
  asyncHandler(async (req, res) => {
    const sub = await Subscription.findOne({ tenant: req.auth!.tenantId })
      .populate('plan', 'name price features')
      .lean();
    res.json(sub ?? null);
  })
);
