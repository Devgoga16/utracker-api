import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { Plan } from '../models/Plan';
import { Subscription } from '../models/Subscription';
import { Tenant } from '../models/Tenant';
import { Membership } from '../models/Membership';
import { Order } from '../models/Order';
import { Bill } from '../models/Bill';
import { Campaign } from '../models/Campaign';
import { Category } from '../models/Category';
import { Customer } from '../models/Customer';
import { OrderLink } from '../models/OrderLink';
import { Product } from '../models/Product';
import { StockMovement } from '../models/StockMovement';
import { WorkflowState } from '../models/WorkflowState';
import { deleteByUrl } from '../services/storage';
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

/**
 * Junta todas las imágenes que este negocio subió a R2.
 *
 * Se recolectan antes de borrar los documentos: después ya no habría de dónde
 * sacar las URLs y los archivos quedarían ocupando espacio para siempre.
 */
async function collectTenantImageUrls(tenantId: Types.ObjectId): Promise<string[]> {
  const [tenant, products, orders, bills] = await Promise.all([
    Tenant.findById(tenantId).select('logoUrl').lean(),
    Product.find({ tenant: tenantId }).select('images').lean(),
    Order.find({ tenant: tenantId }).select('payments.proofImageUrl').lean(),
    Bill.find({ tenant: tenantId }).select('proofImageUrl').lean(),
  ]);

  const urls = [
    tenant?.logoUrl,
    ...products.flatMap((p) => p.images ?? []),
    ...orders.flatMap((o) => (o.payments ?? []).map((p) => p.proofImageUrl)),
    ...bills.map((b) => b.proofImageUrl),
  ].filter((u): u is string => Boolean(u));

  // Las campañas congelan la imagen del producto, así que ya está en la lista.
  return Array.from(new Set(urls));
}

// DELETE /superadmin/tenants/:id
export const deleteTenant = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = new Types.ObjectId(req.params.id as string);

  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Negocio no encontrado');

  /**
   * El nombre exacto viaja en el body como confirmación. Es irreversible y no
   * hay papelera: vale pedir algo más deliberado que un clic.
   */
  const { confirmName } = req.body as { confirmName?: string };
  if (confirmName?.trim() !== tenant.name) {
    throw ApiError.badRequest(
      'Escribe el nombre exacto del negocio para confirmar la eliminación.',
    );
  }

  const imageUrls = await collectTenantImageUrls(tenantId);

  const filter = { tenant: tenantId };
  const [
    orders,
    products,
    customers,
    campaigns,
    orderLinks,
    stockMovements,
    categories,
    workflowStates,
    bills,
    subscriptions,
    memberships,
  ] = await Promise.all([
    Order.deleteMany(filter),
    Product.deleteMany(filter),
    Customer.deleteMany(filter),
    Campaign.deleteMany(filter),
    OrderLink.deleteMany(filter),
    StockMovement.deleteMany(filter),
    Category.deleteMany(filter),
    WorkflowState.deleteMany(filter),
    Bill.deleteMany(filter),
    Subscription.deleteMany(filter),
    Membership.deleteMany(filter),
  ]);

  await tenant.deleteOne();

  // Las imágenes van al final y sin bloquear: si R2 falla, los datos ya se
  // fueron y reintentar el borrado no debe revivir al negocio.
  void Promise.allSettled(imageUrls.map((url) => deleteByUrl(url))).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) console.error(`[tenant:${tenantId}] ${failed} imágenes no se pudieron borrar de R2`);
  });

  res.json({
    ok: true,
    deleted: {
      orders: orders.deletedCount,
      products: products.deletedCount,
      customers: customers.deletedCount,
      campaigns: campaigns.deletedCount,
      orderLinks: orderLinks.deletedCount,
      stockMovements: stockMovements.deletedCount,
      categories: categories.deletedCount,
      workflowStates: workflowStates.deletedCount,
      bills: bills.deletedCount,
      subscriptions: subscriptions.deletedCount,
      memberships: memberships.deletedCount,
      images: imageUrls.length,
    },
  });
});

/**
 * PATCH /superadmin/tenants/:id/whatsapp
 *
 * Define si el negocio manda por su propia sesion o por el bot compartido.
 * Lo decide el superadmin tras acordarlo con el dueno: una sesion propia
 * manda desde el numero del negocio pero cuesta mas.
 */
export const setTenantWhatsapp = asyncHandler(async (req: Request, res: Response) => {
  const { sendUrl, apiKey } = req.body as { sendUrl?: string | null; apiKey?: string | null };

  const tenant = await Tenant.findById(req.params.id).select('+whatsapp');
  if (!tenant) throw ApiError.notFound('Negocio no encontrado');

  const url = sendUrl?.trim() ?? '';
  const key = apiKey?.trim() ?? '';

  // Vaciar ambos = volver al bot compartido de uTracker.
  if (!url && !key) {
    tenant.whatsapp = undefined;
    await tenant.save();
    return res.json({ mode: 'shared' });
  }

  // Media configuracion no sirve y falla recien al intentar enviar.
  if (!url || !key) {
    throw ApiError.badRequest('Para una sesión propia hacen falta la URL y la API key');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw ApiError.badRequest('La URL debe empezar con http:// o https://');
  }

  tenant.whatsapp = { sendUrl: url, apiKey: key };
  await tenant.save();

  // La key no vuelve nunca: solo su cola, para reconocerla de un vistazo.
  res.json({ mode: 'own', sendUrl: url, keyHint: key.slice(-6) });
});

/** GET /superadmin/tenants/:id/whatsapp — sin exponer la key completa. */
export const getTenantWhatsapp = asyncHandler(async (req: Request, res: Response) => {
  const tenant = await Tenant.findById(req.params.id).select('+whatsapp name').lean();
  if (!tenant) throw ApiError.notFound('Negocio no encontrado');

  const own = tenant.whatsapp;
  if (!own?.sendUrl || !own?.apiKey) {
    return res.json({ mode: 'shared', sendUrl: null, keyHint: null });
  }
  res.json({ mode: 'own', sendUrl: own.sendUrl, keyHint: own.apiKey.slice(-6) });
});
