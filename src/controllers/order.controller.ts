import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Order } from '../models/Order';
import { Campaign } from '../models/Campaign';
import { Product } from '../models/Product';
import { Customer } from '../models/Customer';
import { Tenant } from '../models/Tenant';
import { WorkflowState } from '../models/WorkflowState';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { buildHistoryEntry } from '../services/stateHistory';
import { orderCode } from '../utils/orderCode';
import { checkLowStock } from '../services/stockAlerts';
import { deleteByUrl } from '../services/storage';
import {
  notifyCustomerStateChange,
  notifyCustomerPaymentValidated,
  notifyCustomerPaymentRejected,
  sessionForTenant,
} from '../services/whatsapp';
import { StockMovement } from '../models/StockMovement';

/**
 * Picks the right payment WorkflowState based on how much has been paid.
 * Uses position order so it works with any tenant's custom state names.
 *
 * totalPaid === 0            → initial state
 * 0 < totalPaid < total      → first non-initial, non-final, non-cancellation state ("Parcial")
 * totalPaid >= total         → first non-cancellation final state ("Pagado")
 */
/**
 * Solo cuenta lo que el negocio ya confirmó que llegó.
 *
 * Un comprobante que subió el cliente no mueve el estado de pago hasta que
 * alguien lo revise: si no, bastaría con subir cualquier captura para que el
 * pedido figure como pagado.
 */
function validatedTotal(payments: { amount: number; validated?: boolean }[]) {
  return payments.reduce((s, p) => (p.validated === false ? s : s + p.amount), 0);
}

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

/** Suma las unidades de cada producto en el pedido. */
function quantitiesByProduct(order: { items: { product?: Types.ObjectId; quantity: number }[] }) {
  const map = new Map<string, number>();
  for (const line of order.items) {
    if (!line.product) continue;
    const key = line.product.toString();
    map.set(key, (map.get(key) ?? 0) + line.quantity);
  }
  return map;
}

/** Devuelve a la campaña las unidades que este pedido tenía reservadas. */
async function releaseCampaignStock(
  campaignId: Types.ObjectId,
  tenantId: string,
  quantities: Map<string, number>,
  sign: 1 | -1,
) {
  const campaign = await Campaign.findOne({ _id: campaignId, tenant: tenantId });
  if (!campaign) return;
  for (const [productId, qty] of quantities) {
    const item = campaign.items.find((i) => i.product.toString() === productId);
    if (item) item.sold = Math.max(0, item.sold + sign * qty);
  }
  await campaign.save();
}

/**
 * Devuelve al inventario lo que este pedido descontó de verdad.
 *
 * Se apoya en StockMovement en vez de en las cantidades del pedido: uno que se
 * cancela antes de pasar por el estado que descuenta nunca descontó nada, y
 * devolverle stock crearía unidades de la nada.
 */
async function restoreCatalogStock(orderId: Types.ObjectId, tenantId: string, userId?: string) {
  const movements = await StockMovement.find({ order: orderId, tenant: tenantId }).lean();
  if (!movements.length) return;

  const net = new Map<string, number>();
  for (const m of movements) {
    const key = m.product.toString();
    net.set(key, (net.get(key) ?? 0) + m.delta);
  }

  for (const [productId, delta] of net) {
    if (delta >= 0) continue; // ya está devuelto
    const giveBack = -delta;
    await Promise.all([
      Product.updateOne({ _id: productId, tenant: tenantId }, { $inc: { stock: giveBack } }),
      StockMovement.create({
        tenant: tenantId,
        product: productId,
        order: orderId,
        delta: giveBack,
        reason: 'adjustment',
        note: 'Devolución automática por pedido cancelado',
        createdBy: userId ? new Types.ObjectId(userId) : undefined,
      }),
    ]);
  }
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
  // El calendario depende de esto: un pedido sin fecha no se puede planificar.
  if (!scheduledFor?.date) {
    throw ApiError.badRequest('Indica la fecha de entrega o recojo');
  }

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
  const filter: Record<string, unknown> = { tenant: req.auth.tenantId };
  if (req.query.campaign) filter.campaign = req.query.campaign as string;
  const orders = await Order.find(filter)
    .sort({ createdAt: -1 })
    .populate('customer fulfillmentState paymentState');
  res.json({ orders });
});

/**
 * GET /orders/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Los pedidos de una semana segun su fecha programada de entrega o recojo,
 * que es lo que el negocio necesita planificar: no cuando entro el pedido,
 * sino cuando hay que tenerlo listo.
 */
export const calendarOrders = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const { from, to } = req.query as { from?: string; to?: string };
  const isDate = (v?: string) => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));
  if (!isDate(from) || !isDate(to)) {
    throw ApiError.badRequest('Indica from y to con formato YYYY-MM-DD');
  }

  /**
   * Comparacion de texto: las fechas se guardan como "2026-10-08", sin hora ni
   * zona. Pasarlas por Date solo abriria la puerta a corrimientos de un dia.
   */
  const scheduled = await Order.find({
    tenant: req.auth.tenantId,
    'scheduledFor.date': { $gte: from, $lte: to },
  })
    .sort({ 'scheduledFor.date': 1, createdAt: 1 })
    .populate('customer fulfillmentState paymentState');

  /**
   * Los pedidos sin fecha tambien hay que atenderlos, pero no caen en ningun
   * dia. Se devuelven aparte y solo los que siguen abiertos: uno ya entregado
   * sin fecha no aporta nada a la planificacion.
   */
  const closedStates = await WorkflowState.find({
    tenant: req.auth.tenantId,
    kind: 'fulfillment',
    $or: [{ isFinal: true }, { isCancellation: true }],
  }).select('_id');

  const unscheduled = await Order.find({
    tenant: req.auth.tenantId,
    scheduledFor: { $exists: false },
    fulfillmentState: { $nin: closedStates.map((s) => s._id) },
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate('customer fulfillmentState paymentState');

  res.json({ scheduled, unscheduled });
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

        const deducted = productItems.filter((i) => trackedSet.has(i.product!.toString()));

        await Promise.all(
          deducted
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
        // Después del descuento: avisa solo si alguno cruzó su umbral.
        void checkLowStock(
          req.auth.tenantId,
          deducted.map((i) => ({ productId: i.product!.toString(), soldUnits: i.quantity })),
        );
      }
      // Volvió a descontar: si estaba devuelto, ya no lo está.
      order.stockReleased = false;
    }

    /**
     * Cancelar es "este pedido nunca se concretó": vuelven las unidades de la
     * campaña y lo que se hubiera descontado del inventario. El flag evita
     * devolver dos veces si se pasa entre dos estados de cancelación.
     */
    if (state.isCancellation && !order.stockReleased) {
      if (order.campaign) {
        await releaseCampaignStock(
          order.campaign,
          req.auth.tenantId,
          quantitiesByProduct(order),
          -1,
        );
      }
      await restoreCatalogStock(order._id, req.auth.tenantId, req.auth.userId);
      order.stockReleased = true;
    } else if (!state.isCancellation && order.stockReleased) {
      // Se revirtió la cancelación: la campaña vuelve a reservar sus unidades.
      if (order.campaign) {
        await releaseCampaignStock(
          order.campaign,
          req.auth.tenantId,
          quantitiesByProduct(order),
          1,
        );
      }
      order.stockReleased = false;
    }
  } else {
    order.paymentState = state._id;
  }

  order.stateHistory.push(buildHistoryEntry(state, req.auth.userId));
  await order.save();

  // Notificación al cliente (best-effort: no bloquea ni rompe la respuesta).
  if (state.notifyCustomer) {
    const [customer, session] = await Promise.all([
      Customer.findById(order.customer).select('name phone').lean(),
      sessionForTenant(req.auth.tenantId),
    ]);
    if (customer?.phone) {
      notifyCustomerStateChange({
        customerPhone: customer.phone,
        customerName: customer.name,
        stateName: state.name,
        trackingToken: order.trackingToken,
        session,
      });
    }
  }

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
    // Lo registra el negocio, así que no hay nada que validar.
    validated: true,
    validatedAt: new Date(),
    registeredAt: new Date(),
    registeredBy: req.auth.userId ? new Types.ObjectId(req.auth.userId) : undefined,
  });

  // Ya hay un pago nuevo: lo rechazado quedó atrás.
  order.paymentRejectedAt = undefined;

  const totalPaid = validatedTotal(order.payments);
  const newPaymentState = await resolvePaymentState(req.auth.tenantId, totalPaid, order.totalAmount);
  if (newPaymentState && !newPaymentState._id.equals(order.paymentState)) {
    order.paymentState = newPaymentState._id;
    order.stateHistory.push(buildHistoryEntry(newPaymentState, req.auth.userId));
  }

  await order.save();
  res.json({ order });
});

/**
 * El negocio confirma que el adelanto que subió el cliente efectivamente llegó.
 * Recién acá cuenta como pagado y puede mover el estado de pago.
 */
export const validatePayment = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { kind } = req.params as { kind: 'advance' | 'balance' };
  if (!['advance', 'balance'].includes(kind)) {
    throw ApiError.badRequest('kind must be advance or balance');
  }

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  const payment = order.payments.find((p) => p.kind === kind);
  if (!payment) throw ApiError.notFound('No hay un pago de ese tipo en este pedido');
  if (payment.validated) throw ApiError.conflict('Ese pago ya está validado');

  payment.validated = true;
  payment.validatedAt = new Date();
  order.paymentRejectedAt = undefined;

  const totalPaid = validatedTotal(order.payments);
  const newPaymentState = await resolvePaymentState(req.auth.tenantId, totalPaid, order.totalAmount);
  if (newPaymentState && !newPaymentState._id.equals(order.paymentState)) {
    order.paymentState = newPaymentState._id;
    order.stateHistory.push(buildHistoryEntry(newPaymentState, req.auth.userId));
  }

  await order.save();

  // El cliente mandó su comprobante a ciegas: merece saber que fue aceptado.
  const [customer, tenant, session] = await Promise.all([
    Customer.findById(order.customer).select('name phone').lean(),
    Tenant.findById(req.auth.tenantId).select('name').lean(),
    sessionForTenant(req.auth.tenantId),
  ]);
  if (customer?.phone) {
    notifyCustomerPaymentValidated({
      customerPhone: customer.phone,
      customerName: customer.name,
      businessName: tenant?.name ?? 'El negocio',
      amount: payment.amount,
      orderCode: orderCode(order.trackingToken),
      trackingToken: order.trackingToken,
      session,
    });
  }

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
  const totalPaid = validatedTotal(order.payments);
  const newPaymentState = await resolvePaymentState(req.auth.tenantId, totalPaid, order.totalAmount);
  if (newPaymentState && !newPaymentState._id.equals(order.paymentState)) {
    order.paymentState = newPaymentState._id;
    order.stateHistory.push(buildHistoryEntry(newPaymentState, req.auth.userId));
  }

  await order.save();

  /**
   * Borrar un pago que estaba sin validar es, en los hechos, rechazarlo: el
   * cliente lo mandó y necesita saber que tiene que regularizarlo. Borrar uno
   * ya validado es una corrección interna y no se le avisa.
   */
  if (removed.validated === false) {
    // Queda constancia para el seguimiento: el pago borrado no la dejaría.
    order.paymentRejectedAt = new Date();
    await order.save();

    const [customer, tenant, session] = await Promise.all([
      Customer.findById(order.customer).select('name phone').lean(),
      Tenant.findById(req.auth.tenantId).select('name').lean(),
      sessionForTenant(req.auth.tenantId),
    ]);
    if (customer?.phone) {
      notifyCustomerPaymentRejected({
        customerPhone: customer.phone,
        customerName: customer.name,
        businessName: tenant?.name ?? 'El negocio',
        amount: removed.amount,
        orderCode: orderCode(order.trackingToken),
        trackingToken: order.trackingToken,
        session,
      });
    }
  }

  res.json({ order });
});

export const deleteOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  /**
   * El pedido reservó unidades de una campaña: al borrarlo vuelven a estar
   * disponibles, si no el stock de la campaña queda comido para siempre.
   * Si ya estaba cancelado esas unidades volvieron en ese momento, así que
   * devolverlas aquí otra vez las duplicaría.
   */
  if (order.campaign && !order.stockReleased) {
    await releaseCampaignStock(
      order.campaign,
      req.auth.tenantId,
      quantitiesByProduct(order),
      -1,
    );
  }

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
