import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { User } from '../models/User';
import { Subscription } from '../models/Subscription';
import { Plan, IPlanFeatures } from '../models/Plan';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { Membership } from '../models/Membership';
import { WorkflowState } from '../models/WorkflowState';

export const requireSuperAdmin = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.userId) throw ApiError.unauthorized();

  const user = await User.findById(req.auth.userId).select('isSuperAdmin').lean();
  if (!user?.isSuperAdmin) throw ApiError.forbidden('Superadmin access required');

  next();
});

async function getSubscription(tenantId: string) {
  return Subscription.findOne({ tenant: tenantId })
    .populate<{ plan: InstanceType<typeof Plan> }>('plan')
    .lean();
}

export function requireFeature(key: keyof Pick<IPlanFeatures,
  | 'workflowCustomization'
  | 'publicOrderLinks'
  | 'imageUploads'
  | 'deliveryTypes'
  | 'publicTracking'
  | 'advancePayments'
  | 'inventory'
  | 'finances'
>) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw ApiError.unauthorized();

    const sub = await getSubscription(tenantId);
    if (!sub || sub.status === 'suspended') throw ApiError.forbidden('Subscription inactive');

    const features = (sub.plan as any)?.features;
    if (!features?.[key]) throw ApiError.forbidden(`Your plan does not include: ${key}`);

    next();
  });
}

type LimitKind = 'orders' | 'catalog' | 'members' | 'workflowStates';

export function checkLimit(kind: LimitKind) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw ApiError.unauthorized();

    const sub = await getSubscription(tenantId);
    if (!sub || sub.status === 'suspended') throw ApiError.forbidden('Subscription inactive');

    const features = (sub.plan as any)?.features as IPlanFeatures | undefined;
    if (!features) return next();

    const limitMap: Record<LimitKind, keyof Pick<IPlanFeatures, 'maxOrdersPerMonth' | 'maxCatalogItems' | 'maxMembers' | 'maxWorkflowStates'>> = {
      orders: 'maxOrdersPerMonth',
      catalog: 'maxCatalogItems',
      members: 'maxMembers',
      workflowStates: 'maxWorkflowStates',
    };

    const limitKey = limitMap[kind];
    const limit = features[limitKey] as number;
    if (limit === 0) return next(); // 0 = ilimitado

    let count = 0;
    if (kind === 'orders') {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      count = await Order.countDocuments({ tenant: tenantId, createdAt: { $gte: start } });
    } else if (kind === 'catalog') {
      count = await Product.countDocuments({ tenant: tenantId, isActive: true });
    } else if (kind === 'members') {
      count = await Membership.countDocuments({ tenant: tenantId, isActive: true });
    } else if (kind === 'workflowStates') {
      count = await WorkflowState.countDocuments({ tenant: tenantId });
    }

    if (count >= limit) {
      throw ApiError.forbidden(`Limit reached for ${kind} (${count}/${limit})`);
    }

    next();
  });
}
