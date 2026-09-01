import crypto from 'crypto';
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { Campaign } from '../models/Campaign';
import { Product } from '../models/Product';
import { Order } from '../models/Order';
import { Customer } from '../models/Customer';
import { WorkflowState } from '../models/WorkflowState';
import { Tenant } from '../models/Tenant';
import { env } from '../config/env';
import { notifyOwnerNewOrder } from '../services/whatsapp';

function generateToken(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Owner ────────────────────────────────────────────────────────────────────

export const listCampaigns = asyncHandler(async (req: Request, res: Response) => {
  const campaigns = await Campaign.find({ tenant: req.auth!.tenantId })
    .sort({ startDate: -1 })
    .lean();
  res.json({ campaigns });
});

export const getCampaign = asyncHandler(async (req: Request, res: Response) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    tenant: req.auth!.tenantId,
  }).lean();
  if (!campaign) throw ApiError.notFound('Campaña no encontrada');
  res.json({ campaign });
});

export const createCampaign = asyncHandler(async (req: Request, res: Response) => {
  const { name, description, startDate, endDate, items, deliveryTypes, schedule } = req.body as {
    name: string;
    description?: string;
    startDate: string;
    endDate: string;
    items: { productId: string; stock: number }[];
    deliveryTypes?: string[];
    schedule?: { franjas: string[] };
  };

  if (!name || !startDate || !endDate || !items?.length) {
    throw ApiError.badRequest('Faltan campos requeridos');
  }
  if (!deliveryTypes?.length) {
    throw ApiError.badRequest('Debes seleccionar al menos un tipo de entrega');
  }
  if (new Date(startDate) >= new Date(endDate)) {
    throw ApiError.badRequest('La fecha de inicio debe ser antes que la de fin');
  }

  // Snapshot products
  const productIds = items.map((i) => i.productId);
  const products = await Product.find({
    _id: { $in: productIds },
    tenant: req.auth!.tenantId,
  }).lean();

  if (products.length !== productIds.length) {
    throw ApiError.badRequest('Uno o más productos no existen en tu catálogo');
  }

  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  const campaignItems = items.map((i) => {
    const p = productMap.get(i.productId)!;
    return {
      product: p._id,
      name: p.name,
      price: p.price,
      imageUrl: p.images?.[0] ?? undefined,
      stock: i.stock,
      sold: 0,
    };
  });

  const campaign = await Campaign.create({
    tenant: req.auth!.tenantId,
    token: generateToken(),
    name,
    description,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    items: campaignItems,
    deliveryTypes: deliveryTypes as any,
    schedule: schedule?.franjas?.length ? (schedule as any) : undefined,
    status: 'draft',
  });

  res.status(201).json({ campaign });
});

export const updateCampaign = asyncHandler(async (req: Request, res: Response) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    tenant: req.auth!.tenantId,
  });
  if (!campaign) throw ApiError.notFound('Campaña no encontrada');
  if (campaign.status === 'ended' || campaign.status === 'cancelled') {
    throw ApiError.badRequest('No puedes editar una campaña terminada o cancelada');
  }

  const { name, description, startDate, endDate, status, items, deliveryTypes, schedule } = req.body as {
    name?: string;
    description?: string;
    startDate?: string;
    endDate?: string;
    status?: string;
    items?: { productId: string; stock: number }[];
    deliveryTypes?: string[];
    schedule?: { franjas: string[] };
  };

  if (name) campaign.name = name;
  if (description !== undefined) campaign.description = description;
  if (startDate) campaign.startDate = new Date(startDate);
  if (endDate) campaign.endDate = new Date(endDate);
  if (status && ['draft', 'active', 'cancelled'].includes(status)) {
    campaign.status = status as any;
  }
  if (deliveryTypes?.length) campaign.deliveryTypes = deliveryTypes as any;
  if (schedule?.franjas !== undefined) campaign.schedule = schedule as any;

  if (items && items.length > 0) {
    const productIds = items.map((i) => i.productId);
    const products = await Product.find({
      _id: { $in: productIds },
      tenant: req.auth!.tenantId,
    }).lean();
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    campaign.items = items.map((i) => {
      const p = productMap.get(i.productId)!;
      const existing = campaign.items.find((ci) => ci.product.toString() === i.productId);
      return {
        product: p._id,
        name: p.name,
        price: p.price,
        imageUrl: p.images?.[0] ?? undefined,
        stock: i.stock,
        sold: existing?.sold ?? 0,
      };
    }) as any;
  }

  await campaign.save();
  res.json({ campaign });
});

export const deleteCampaign = asyncHandler(async (req: Request, res: Response) => {
  const campaign = await Campaign.findOneAndDelete({
    _id: req.params.id,
    tenant: req.auth!.tenantId,
  });
  if (!campaign) throw ApiError.notFound('Campaña no encontrada');
  res.json({ ok: true });
});

// ─── Public ───────────────────────────────────────────────────────────────────

export const getPublicCampaign = asyncHandler(async (req: Request, res: Response) => {
  const campaign = await Campaign.findOne({ token: req.params.token }).lean();
  if (!campaign) throw ApiError.notFound('Campaña no encontrada');

  // La campaña se muestra con la identidad de la tienda (logo, nombre, color).
  const tenant = await Tenant.findById(campaign.tenant)
    .select('name slug logoUrl phone brandColor')
    .lean();

  res.json({ campaign, tenant });
});

export const confirmCampaignOrder = asyncHandler(async (req: Request, res: Response) => {
  const campaign = await Campaign.findOne({ token: req.params.token });
  if (!campaign) throw ApiError.notFound('Campaña no encontrada');

  const now = new Date();
  if (campaign.status === 'cancelled') throw ApiError.badRequest('Esta campaña fue cancelada');
  if (campaign.status === 'ended' || now > campaign.endDate) {
    throw ApiError.badRequest('Esta campaña ya terminó');
  }
  if (campaign.status !== 'active') {
    throw ApiError.badRequest('Esta campaña no está activa aún');
  }

  const {
    customer: customerData,
    orderItems,
    type,
    address,
    scheduledFor,
  } = req.body as {
    customer: { name: string; phone: string; email?: string };
    orderItems: { productId: string; quantity: number }[];
    type: string;
    address?: string;
    scheduledFor?: { date: string; franja: 'morning' | 'afternoon' | 'evening' };
  };

  if (!customerData?.name || !customerData?.phone) {
    throw ApiError.badRequest('Nombre y teléfono del cliente son requeridos');
  }
  if (!orderItems?.length) throw ApiError.badRequest('Debes seleccionar al menos un producto');

  const resolvedType = type || 'pickup';
  if (!campaign.deliveryTypes.includes(resolvedType as any)) {
    throw ApiError.badRequest(`Tipo de entrega "${resolvedType}" no está permitido en esta campaña`);
  }

  // Validate stock availability and build order lines
  const orderLines: { product: any; name: string; unitPrice: number; quantity: number }[] = [];

  for (const oi of orderItems) {
    const item = campaign.items.find((i) => i.product.toString() === oi.productId);
    if (!item) throw ApiError.badRequest(`Producto no pertenece a esta campaña`);
    const available = item.stock - item.sold;
    if (oi.quantity > available) {
      throw ApiError.badRequest(
        `Solo quedan ${available} unidades de "${item.name}" en esta campaña`,
      );
    }
    orderLines.push({
      product: item.product,
      name: item.name,
      unitPrice: item.price,
      quantity: oi.quantity,
    });
  }

  // Deduct campaign stock
  for (const oi of orderItems) {
    await Campaign.updateOne(
      { _id: campaign._id, 'items.product': oi.productId },
      { $inc: { 'items.$.sold': oi.quantity } },
    );
  }

  // Upsert customer
  let customer = await Customer.findOne({
    tenant: campaign.tenant,
    phone: customerData.phone,
  });
  if (!customer) {
    customer = await Customer.create({
      tenant: campaign.tenant,
      name: customerData.name,
      phone: customerData.phone,
      email: customerData.email,
      addresses: [],
    });
  }

  // Get initial workflow states
  const fulfillmentState = await WorkflowState.findOne({
    tenant: campaign.tenant,
    kind: 'fulfillment',
    isInitial: true,
  });
  const paymentState = await WorkflowState.findOne({
    tenant: campaign.tenant,
    kind: 'payment',
    isInitial: true,
  });

  if (!fulfillmentState || !paymentState) {
    throw ApiError.badRequest('El negocio no tiene workflow configurado');
  }

  const totalAmount = orderLines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

  const order = await Order.create({
    tenant: campaign.tenant,
    customer: customer._id,
    items: orderLines,
    totalAmount,
    type: resolvedType as 'pickup' | 'delivery_own',
    delivery: resolvedType !== 'pickup' && address ? { address } : undefined,
    scheduledFor: scheduledFor ?? undefined,
    campaign: campaign._id,
    fulfillmentState: fulfillmentState._id,
    paymentState: paymentState._id,
    stateHistory: [
      {
        kind: 'fulfillment',
        state: fulfillmentState._id,
        stateName: fulfillmentState.name,
        stateColor: fulfillmentState.color,
        stateIcon: fulfillmentState.icon,
        changedAt: new Date(),
      },
      {
        kind: 'payment',
        state: paymentState._id,
        stateName: paymentState.name,
        stateColor: paymentState.color,
        stateIcon: paymentState.icon,
        changedAt: new Date(),
      },
    ],
    payments: [],
    createdVia: 'order_link',
    notes: `Pedido de campaña: ${campaign.name}`,
  });

  const populated = await Order.findById((order as any)._id).populate('customer');

  // Notificar al dueño por WhatsApp
  const ownerTenant = await Tenant.findById(campaign.tenant).select('phone').lean();
  if (ownerTenant?.phone) {
    notifyOwnerNewOrder({
      ownerPhone: ownerTenant.phone,
      customerName: customerData.name,
      customerPhone: customerData.phone,
      items: orderLines.map((l) => ({ name: l.name, quantity: l.quantity, unitPrice: l.unitPrice })),
      total: totalAmount,
      source: `campaña: ${campaign.name}`,
    });
  }

  res.status(201).json({
    order: populated,
    trackingUrl: `${env.frontendUrl}/track/${(populated as any).trackingToken}`,
  });
});
