import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { Customer } from '../models/Customer';
import { WorkflowState } from '../models/WorkflowState';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { buildHistoryEntry } from '../services/stateHistory';
import { deleteByUrl } from '../services/storage';
import { StockMovement } from '../models/StockMovement';

/**
 * Picks the right payment WorkflowState based on how much has been paid.
 * Uses position order so it works with any tenant's custom state names.
 *
 * totalPaid === 0            → initial state
 * 0 < totalPaid < total      → first non-initial, non-final, non-cancellation state ("Parcial")
 * totalPaid >= total         → first non-cancellation final state ("Pagado")
 */
async function resolvePaymentState(tenantId: string, totalPaid: number, totalAmount: number) {
  const states = await WorkflowState.find({ tenant: tenantId, kind: 'payment' }).sort({ position: 1 });
  if (totalPaid >= totalAmount) {
    return states.find((s) => s.isFinal && !s.isCancellation) ?? states.find((s) => s.isFinal) ?? null;
  }
  if (totalPaid > 0) {
    return states.find((s) => !s.isInitial && !s.isFinal) ?? states.find((s) => s.isInitial) ?? null;
  }
  return states.find((s) => s.isInitial) ?? null;
}

interface CreateOrderItemInput {
  /** Omit for an ad-hoc line; then `name` and `unitPrice` are required. */
  productId?: string;
  name?: string;
  /** Overrides the catalog price. Mandatory for 'quoted' entries. */
  unitPrice?: number;
  quantity: number;
  variant?: string;
  specs?: string;
}

export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const tenantId = req.auth.tenantId;

  const {
    customer: customerInput,
    items: itemsInput,
    type,
    delivery,
    notes,
    advance,
    scheduledFor,
  } = req.body as {
    customer: { name: string; phone: string; email?: string; address?: string };
    items: CreateOrderItemInput[];
    type: 'pickup' | 'delivery_third_party' | 'delivery_own';
    delivery?: { address?: string; reference?: string; courierName?: string; driver?: string };
    notes?: string;
    advance?: { amount: number; proofImageUrl?: string };
    scheduledFor?: { date: string; franja: 'morning' | 'afternoon' | 'evening' };
  };

  if (!customerInput?.name || !customerInput?.phone) throw ApiError.badRequest('customer.name and customer.phone are required');
  if (!itemsInput?.length) throw ApiError.badRequest('At least one item is required');
  if (!type) throw ApiError.badRequest('type is required');

  let customer = await Customer.findOne({ tenant: tenantId, phone: customerInput.phone });
  if (!customer) {
    customer = await Customer.create({
      tenant: tenantId,
      name: customerInput.name,
      phone: customerInput.phone,
      email: customerInput.email,
      addresses: customerInput.address ? [{ address: customerInput.address }] : [],
    });
  }

  const catalogIds = itemsInput.flatMap((i) => (i.productId ? [i.productId] : []));
  const products = catalogIds.length
    ? await Product.find({ _id: { $in: catalogIds }, tenant: tenantId })
    : [];
  if (products.length !== new Set(catalogIds).size) {
    throw ApiError.badRequest('Uno o más ítems del catálogo no existen');
  }

  const items = itemsInput.map((input) => {
    if (input.quantity < 1) throw ApiError.badRequest('La cantidad debe ser al menos 1');
    if (input.unitPrice !== undefined && input.unitPrice < 0) {
      throw ApiError.badRequest('El precio no puede ser negativo');
    }

    // Ad-hoc line: a one-off job that never made it into the catalog.
    if (!input.productId) {
      if (!input.name?.trim()) throw ApiError.badRequest('Una línea libre necesita un nombre');
      if (input.unitPrice === undefined) throw ApiError.badRequest('Una línea libre necesita un precio');
      return {
        name: input.name.trim(),
        unitPrice: input.unitPrice,
        quantity: input.quantity,
        specs: input.specs,
      };
    }

    const product = products.find((p) => p._id.toString() === input.productId)!;
    const variant = input.variant ? product.variants.find((v) => v.name === input.variant) : undefined;

    if (product.pricingMode === 'quoted' && input.unitPrice === undefined) {
      throw ApiError.badRequest(`"${product.name}" se cotiza por trabajo: indicá el precio`);
    }

    return {
      product: product._id,
      name: product.name,
      unitPrice: input.unitPrice ?? product.price + (variant?.priceModifier ?? 0),
      quantity: input.quantity,
      variant: input.variant,
      specs: input.specs,
    };
  });

  const totalAmount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  const [initialFulfillment, initialPayment] = await Promise.all([
    WorkflowState.findOne({ tenant: tenantId, kind: 'fulfillment', isInitial: true }),
    WorkflowState.findOne({ tenant: tenantId, kind: 'payment', isInitial: true }),
  ]);
  if (!initialFulfillment || !initialPayment) throw ApiError.badRequest('Tenant workflow is not configured');

  const initialPayments = advance && advance.amount > 0
    ? [{ kind: 'advance' as const, amount: advance.amount, proofImageUrl: advance.proofImageUrl, registeredAt: new Date(), registeredBy: req.auth.userId ? new Types.ObjectId(req.auth.userId) : undefined }]
    : [];

  const advanceTotalPaid = initialPayments.reduce((s, p) => s + p.amount, 0);
  const autoPaymentState = advanceTotalPaid > 0
    ? await resolvePaymentState(tenantId, advanceTotalPaid, totalAmount)
    : null;
  const startPaymentState = autoPaymentState ?? initialPayment;

  const paymentHistory = [buildHistoryEntry(initialPayment, req.auth.userId)];
  if (autoPaymentState && !autoPaymentState._id.equals(initialPayment._id)) {
    paymentHistory.push(buildHistoryEntry(autoPaymentState, req.auth.userId));
  }

  const order = await Order.create({
    tenant: tenantId,
    customer: customer._id,
    items,
    totalAmount,
    type,
    delivery: type === 'pickup' ? undefined : delivery,
    fulfillmentState: initialFulfillment._id,
    paymentState: startPaymentState._id,
    stateHistory: [
      buildHistoryEntry(initialFulfillment, req.auth.userId),
      ...paymentHistory,
    ],
    payments: initialPayments,
    createdVia: 'manual',
    scheduledFor,
    notes,
    createdBy: req.auth.userId,
  });

  res.status(201).json({ order });
});

export const listOrders = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const orders = await Order.find({ tenant: req.auth.tenantId })
    .sort({ createdAt: -1 })
    .populate('customer fulfillmentState paymentState');
  res.json({ orders });
});

export const getOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  // stateHistory carries its own frozen display data, so it needs no populate.
  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId }).populate(
    'customer fulfillmentState paymentState'
  );
  if (!order) throw ApiError.notFound('Order not found');
  res.json({ order });
});

export const updateOrderState = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { kind, stateId, link } = req.body as { kind: 'fulfillment' | 'payment'; stateId: string; link?: string };
  if (!kind || !stateId) throw ApiError.badRequest('kind and stateId are required');

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  const state = await WorkflowState.findOne({ _id: stateId, tenant: req.auth.tenantId, kind });
  if (!state) throw ApiError.badRequest('Invalid state for this tenant/kind');

  if (req.auth.role && !state.allowedRoles.includes(req.auth.role)) {
    throw ApiError.forbidden('Your role cannot set this state');
  }

  if (kind === 'fulfillment') {
    order.fulfillmentState = state._id;
    order.fulfillmentLink = link?.trim() || undefined;

    if (state.deductsStock) {
      const productItems = order.items.filter((i) => i.product);
      if (productItems.length) {
        const productIds = productItems.map((i) => i.product!);
        const tracked = await Product.find({
          _id: { $in: productIds },
          tenant: req.auth.tenantId,
          trackStock: true,
        }).select('_id');
        const trackedSet = new Set(tracked.map((p) => p._id.toString()));

        await Promise.all(
          productItems
            .filter((i) => trackedSet.has(i.product!.toString()))
            .map((i) =>
              Promise.all([
                Product.updateOne({ _id: i.product }, { $inc: { stock: -i.quantity } }),
                StockMovement.create({
                  tenant: req.auth!.tenantId,
                  product: i.product,
                  order: order._id,
                  delta: -i.quantity,
                  reason: 'order',
                  createdBy: req.auth!.userId ? new Types.ObjectId(req.auth!.userId) : undefined,
                }),
              ])
            )
        );
      }
    }
  } else {
    order.paymentState = state._id;
  }

  order.stateHistory.push(buildHistoryEntry(state, req.auth.userId));
  await order.save();

  res.json({ order });
});

export const registerPayment = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { kind, amount, proofImageUrl, note } = req.body as {
    kind: 'advance' | 'balance';
    amount: number;
    proofImageUrl?: string;
    note?: string;
  };

  if (!kind || !['advance', 'balance'].includes(kind)) throw ApiError.badRequest('kind must be advance or balance');
  if (!amount || amount <= 0) throw ApiError.badRequest('amount must be greater than 0');

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  const alreadyExists = order.payments.some((p) => p.kind === kind);
  if (alreadyExists) throw ApiError.conflict(`Ya existe un pago de tipo "${kind === 'advance' ? 'adelanto' : 'saldo'}"`);

  order.payments.push({
    kind,
    amount,
    proofImageUrl,
    note,
    registeredAt: new Date(),
    registeredBy: req.auth.userId ? new Types.ObjectId(req.auth.userId) : undefined,
  });

  const totalPaid = order.payments.reduce((s, p) => s + p.amount, 0);
  const newPaymentState = await resolvePaymentState(req.auth.tenantId, totalPaid, order.totalAmount);
  if (newPaymentState && !newPaymentState._id.equals(order.paymentState)) {
    order.paymentState = newPaymentState._id;
    order.stateHistory.push(buildHistoryEntry(newPaymentState, req.auth.userId));
  }

  await order.save();
  res.json({ order });
});

export const deletePayment = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { kind } = req.params as { kind: 'advance' | 'balance' };
  if (!['advance', 'balance'].includes(kind)) throw ApiError.badRequest('kind must be advance or balance');

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  const idx = order.payments.findIndex((p) => p.kind === kind);
  if (idx === -1) throw ApiError.notFound(`No hay un pago de tipo "${kind === 'advance' ? 'adelanto' : 'saldo'}"`);

  const [removed] = order.payments.splice(idx, 1);

  // Clean up proof image from R2 (best-effort).
  if (removed.proofImageUrl) await deleteByUrl(removed.proofImageUrl);

  // Re-derive payment state from the remaining payments.
  const totalPaid = order.payments.reduce((s, p) => s + p.amount, 0);
  const newPaymentState = await resolvePaymentState(req.auth.tenantId, totalPaid, order.totalAmount);
  if (newPaymentState && !newPaymentState._id.equals(order.paymentState)) {
    order.paymentState = newPaymentState._id;
    order.stateHistory.push(buildHistoryEntry(newPaymentState, req.auth.userId));
  }

  await order.save();
  res.json({ order });
});

export const deleteOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  // Clean up R2 payment proof images (best-effort).
  await Promise.allSettled(
    order.payments
      .filter((p) => p.proofImageUrl)
      .map((p) => deleteByUrl(p.proofImageUrl!))
  );

  await order.deleteOne();
  res.status(204).send();
});

export const addDeliveryAttempt = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { succeeded, reason, note } = req.body as { succeeded: boolean; reason?: string; note?: string };

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.type !== 'delivery_own' || !order.delivery) throw ApiError.badRequest('Order has no own-delivery info');

  order.delivery.attempts.push({ attemptedAt: new Date(), succeeded, reason, note });
  await order.save();

  res.json({ order });
});
