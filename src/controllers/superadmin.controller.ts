import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { Plan } from '../models/Plan';
import { Subscription } from '../models/Subscription';
import { Tenant } from '../models/Tenant';
import { Membership } from '../models/Membership';
import { Order } from '../models/Order';
import { Bill } from '../models/Bill';
import { Types } from 'mongoose';

// GET /superadmin/stats
export const getStats = asyncHandler(async (_req: Request, res: Response) => {
  const [totalTenants, statusCounts, totalPlans, ordersThisMonth] = await Promise.all([
    Tenant.countDocuments(),
    Subscription.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Plan.countDocuments({ isActive: true }),
    Order.countDocuments({
      createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
    }),
  ]);

  const byStatus: Record<string, number> = { trial: 0, active: 0, suspended: 0 };
  for (const row of statusCounts) byStatus[row._id] = row.count;

  res.json({ totalTenants, totalPlans, ordersThisMonth, subscriptions: byStatus });
});

// GET /superadmin/plans
export const listPlans = asyncHandler(async (_req: Request, res: Response) => {
  const plans = await Plan.find().sort({ price: 1 }).lean();
  res.json(plans);
});

// POST /superadmin/plans
export const createPlan = asyncHandler(async (req: Request, res: Response) => {
  const { name, description, price, features } = req.body;
  if (!name || features === undefined) throw ApiError.badRequest('name and features are required');

  const plan = await Plan.create({ name, description, price: price ?? 0, features });
  res.status(201).json(plan);
});

// PUT /superadmin/plans/:id
export const updatePlan = asyncHandler(async (req: Request, res: Response) => {
  const { name, description, price, features, isActive } = req.body;
  const plan = await Plan.findByIdAndUpdate(
    req.params.id,
    { $set: { name, description, price, features, isActive } },
    { new: true, runValidators: true }
  );
  if (!plan) throw ApiError.notFound('Plan not found');
  res.json(plan);
});

// DELETE /superadmin/plans/:id
export const deletePlan = asyncHandler(async (req: Request, res: Response) => {
  const inUse = await Subscription.countDocuments({ plan: req.params.id });
  if (inUse > 0) {
    // Soft-delete: mark inactive so existing subscriptions still reference it
    await Plan.findByIdAndUpdate(req.params.id, { isActive: false });
    return res.json({ message: 'Plan deactivated (in use by subscriptions)' });
  }
  await Plan.findByIdAndDelete(req.params.id);
  res.status(204).send();
});

// GET /superadmin/tenants
export const listTenants = asyncHandler(async (_req: Request, res: Response) => {
  const tenants = await Tenant.find().sort({ createdAt: -1 }).lean();
  const tenantIds = tenants.map((t) => t._id);

  const [ownerMemberships, subscriptions] = await Promise.all([
    Membership.find({ tenant: { $in: tenantIds }, role: 'owner', isActive: true })
      .populate('user', 'name email')
      .lean(),
    Subscription.find({ tenant: { $in: tenantIds } })
      .populate('plan', 'name price')
      .lean(),
  ]);

  const ownerMap = new Map(ownerMemberships.map((m) => [m.tenant.toString(), m.user]));
  const subMap = new Map(subscriptions.map((s) => [s.tenant.toString(), s]));

  const result = tenants.map((t) => ({
    ...t,
    owner: ownerMap.get(t._id.toString()) ?? null,
    subscription: subMap.get(t._id.toString()) ?? null,
  }));

  res.json(result);
});

// PATCH /superadmin/tenants/:id/subscription
export const assignSubscription = asyncHandler(async (req: Request, res: Response) => {
  const { planId, status, expiresAt, notes } = req.body;
  if (!planId) throw ApiError.badRequest('planId is required');

  const plan = await Plan.findById(planId);
  if (!plan) throw ApiError.notFound('Plan not found');

  const sub = await Subscription.findOneAndUpdate(
    { tenant: req.params.id },
    {
      $set: {
        plan: new Types.ObjectId(planId),
        status: status ?? 'active',
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        assignedBy: req.auth!.userId,
        notes: notes ?? undefined,
      },
    },
    { new: true, upsert: true, runValidators: true }
  ).populate('plan', 'name price features');

  // Auto-generate bill for the current month when plan has a price
  if (plan.price > 0 && sub) {
    const tenantId = new Types.ObjectId(req.params.id as string);
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const exists = await Bill.exists({ tenant: tenantId, period });
    if (!exists) {
      const dueDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      await Bill.create({
        tenant: tenantId,
        subscription: sub._id,
        period,
        planName: plan.name,
        amount: plan.price,
        dueDate,
        status: 'pending',
      });
    }
  }

  res.json(sub);
});

// PATCH /superadmin/tenants/:id/toggle
export const toggleSubscription = asyncHandler(async (req: Request, res: Response) => {
  const sub = await Subscription.findOne({ tenant: req.params.id });
  if (!sub) throw ApiError.notFound('No hay suscripción para este negocio');
  sub.status = sub.status === 'suspended' ? 'active' : 'suspended';
  await sub.save();
  res.json({ status: sub.status });
});
