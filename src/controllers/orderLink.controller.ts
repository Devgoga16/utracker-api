import { randomBytes } from 'crypto';
import { Request, Response } from 'express';
import { OrderLink, OrderLinkDeliveryType } from '../models/OrderLink';
import { Product } from '../models/Product';
import { Customer } from '../models/Customer';
import { Order } from '../models/Order';
import { WorkflowState } from '../models/WorkflowState';
import { Tenant } from '../models/Tenant';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { buildHistoryEntry } from '../services/stateHistory';

interface OrderLinkItemInput {
  productId: string;
  quantity: number;
  variant?: string;
}

export const createOrderLink = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { items, deliveryType } = req.body as { items: OrderLinkItemInput[]; deliveryType?: OrderLinkDeliveryType };
  if (!items?.length) throw ApiError.badRequest('At least one item is required');

  const productIds = items.map((i) => i.productId);
  const found = await Product.find({ _id: { $in: productIds }, tenant: req.auth.tenantId });
  if (found.length !== new Set(productIds).size) {
    throw ApiError.badRequest('Uno o más ítems del catálogo no existen');
  }

  // The customer would see a price nobody agreed on yet.
  const quoted = found.find((p) => p.pricingMode === 'quoted');
  if (quoted) {
    throw ApiError.badRequest(
      `"${quoted.name}" se cotiza por trabajo, así que no se puede enviar por link. Cargá el pedido vos con el precio acordado.`
    );
  }

  const token = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + env.orderLinkTtlHours * 60 * 60 * 1000);

  const link = await OrderLink.create({
    tenant: req.auth.tenantId,
    token,
    items: items.map((i) => ({ product: i.productId, quantity: i.quantity, variant: i.variant })),
    deliveryType: deliveryType ?? 'customer_choice',
    expiresAt,
    createdBy: req.auth.userId,
  });

  res.status(201).json({ link, expiresAt, ttlHours: env.orderLinkTtlHours });
});

// Returns the link with raw ObjectId refs. Callers that need product details
// populate explicitly -- populating here would break the id comparisons below.
async function resolveLinkOrExpire(token: string) {
  const link = await OrderLink.findOne({ token });
  if (!link) throw ApiError.notFound('Order link not found');

  if (link.status === 'pending' && link.expiresAt.getTime() < Date.now()) {
    link.status = 'expired';
    await link.save();
  }

  return link;
}

// Public endpoint: customer opens the link.
export const getPublicOrderLink = asyncHandler(async (req: Request, res: Response) => {
  const link = await resolveLinkOrExpire(String(req.params.token));
  if (link.status !== 'pending') throw ApiError.conflict(`Order link is ${link.status}`);

  await link.populate('items.product');
  const tenant = await Tenant.findById(link.tenant);
  res.json({
    tenant: { name: tenant?.name, logoUrl: tenant?.logoUrl, schedule: tenant?.schedule ?? [] },
    items: link.items,
    deliveryType: link.deliveryType,
    expiresAt: link.expiresAt,
  });
});

// Public endpoint: customer submits their info to confirm the order.
export const confirmPublicOrderLink = asyncHandler(async (req: Request, res: Response) => {
  const link = await resolveLinkOrExpire(String(req.params.token));
  if (link.status !== 'pending') throw ApiError.conflict(`Order link is ${link.status}`);

  const { customer: customerInput, deliveryType, delivery, scheduledFor } = req.body as {
    customer: { name: string; phone: string; email?: string; address?: string };
    deliveryType?: 'pickup' | 'delivery_third_party' | 'delivery_own';
    delivery?: { address?: string; reference?: string };
    scheduledFor?: { date: string; franja: 'morning' | 'afternoon' | 'evening' };
  };
  if (!customerInput?.name || !customerInput?.phone) throw ApiError.badRequest('customer.name and customer.phone are required');

  const type = link.deliveryType === 'customer_choice' ? deliveryType : link.deliveryType;
  if (!type) throw ApiError.badRequest('deliveryType is required');

  let customer = await Customer.findOne({ tenant: link.tenant, phone: customerInput.phone });
  if (!customer) {
    customer = await Customer.create({
      tenant: link.tenant,
      name: customerInput.name,
      phone: customerInput.phone,
      email: customerInput.email,
      addresses: customerInput.address ? [{ address: customerInput.address }] : [],
    });
  }

  const products = await Product.find({ _id: { $in: link.items.map((i) => i.product) }, tenant: link.tenant });
  const items = link.items.map((linkItem) => {
    const product = products.find((p) => p._id.equals(linkItem.product));
    if (!product) throw ApiError.conflict('Un producto de este pedido ya no está disponible');

    const variant = linkItem.variant ? product.variants.find((v) => v.name === linkItem.variant) : undefined;
    return {
      product: product._id,
      name: product.name,
      unitPrice: product.price + (variant?.priceModifier ?? 0),
      quantity: linkItem.quantity,
      variant: linkItem.variant,
    };
  });
  const totalAmount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  const [initialFulfillment, initialPayment] = await Promise.all([
    WorkflowState.findOne({ tenant: link.tenant, kind: 'fulfillment', isInitial: true }),
    WorkflowState.findOne({ tenant: link.tenant, kind: 'payment', isInitial: true }),
  ]);
  if (!initialFulfillment || !initialPayment) throw ApiError.badRequest('Tenant workflow is not configured');

  const order = await Order.create({
    tenant: link.tenant,
    customer: customer._id,
    items,
    totalAmount,
    type,
    delivery: type === 'pickup' ? undefined : delivery,
    fulfillmentState: initialFulfillment._id,
    paymentState: initialPayment._id,
    stateHistory: [buildHistoryEntry(initialFulfillment), buildHistoryEntry(initialPayment)],
    createdVia: 'order_link',
    orderLink: link._id,
    scheduledFor,
  });

  link.status = 'used';
  link.resultingOrder = order._id;
  await link.save();

  res.status(201).json({ order });
});
