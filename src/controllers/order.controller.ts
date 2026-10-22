import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Order, PAYMENT_METHOD_KINDS, PaymentMethodKind } from '../models/Order';
import { CashSession } from '../models/CashSession';
import { Campaign } from '../models/Campaign';
import { Product } from '../models/Product';
import { applyFulfillmentState, syncOrderStock } from '../services/orderStock';
import { Customer } from '../models/Customer';
import { Tenant } from '../models/Tenant';
import { WorkflowState } from '../models/WorkflowState';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { buildHistoryEntry } from '../services/stateHistory';
import { orderCode } from '../utils/orderCode';
import { deleteByUrl } from '../services/storage';
import {
  notifyCustomerStateChange,
  notifyCustomerPaymentValidated,
  notifyCustomerPaymentRejected,
  sessionForTenant,
} from '../services/whatsapp';
import {
  ensurePaymentIds,
  kindForNewPayment,
  pendingTotal,
  refundedTotal,
  resolvePaymentState,
  syncPaymentState,
  validatedTotal,
} from '../services/payments';

// Re-exportado: el punto de venta lo usa desde aquí.
export { resolvePaymentState };

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
    advance?: { amount: number; proofImageUrl?: string; method?: string };
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
      throw ApiError.badRequest(`"${product.name}" se cotiza por trabajo: indica el precio`);
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

  /*
   * Lo que el cliente dejó pagado al hacer el pedido. Puede ser todo: alguien
   * que paga completo por adelantado no tiene por qué registrarlo en dos pasos.
   */
  const advanceAmount = Math.round(Number(advance?.amount ?? 0) * 100) / 100;
  if (advanceAmount > totalAmount + 0.001) {
    throw ApiError.badRequest('Lo pagado no puede ser mayor al total del pedido');
  }
  const advanceMethod = parseMethod(advance?.method);
  const openSession = advanceAmount > 0 && advanceMethod
    ? await CashSession.findOne({ tenant: tenantId, status: 'open' }).select('_id').lean()
    : null;

  const initialPayments = advanceAmount > 0
    ? [{
        kind: kindForNewPayment(0, advanceAmount, totalAmount),
        amount: advanceAmount,
        proofImageUrl: advance?.proofImageUrl || undefined,
        validated: true,
        validatedAt: new Date(),
        registeredAt: new Date(),
        registeredBy: req.auth.userId ? new Types.ObjectId(req.auth.userId) : undefined,
        method: advanceMethod,
        cashSession: openSession?._id,
      }]
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

  // Por si el estado inicial es el que descuenta stock.
  await syncOrderStock(order, tenantId, req.auth.userId);

  res.status(201).json({ order });
});

export const listOrders = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const filter: Record<string, unknown> = { tenant: req.auth.tenantId };
  if (req.query.campaign) filter.campaign = req.query.campaign as string;
  /*
   * Las ventas de mostrador no son pedidos que haya que atender: nacen
   * entregadas y pagadas. Mezclarlas llenaría la lista de algo que ya terminó;
   * tienen su propio historial en la caja.
   */
  filter.createdVia = req.query.channel === 'pos' ? 'pos' : { $ne: 'pos' };
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
  if (!Types.ObjectId.isValid(String(req.params.id))) throw ApiError.notFound('Order not found');
  await ensurePaymentIds(String(req.params.id), req.auth.tenantId);
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
  if (!stateId) throw ApiError.badRequest('stateId is required');
  // El estado de pago sale de lo cobrado: moverlo a mano lo dejaría mintiendo.
  if (kind === 'payment') {
    throw ApiError.badRequest('El estado de pago se actualiza solo al registrar o devolver pagos.');
  }

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  const state = await WorkflowState.findOne({ _id: stateId, tenant: req.auth.tenantId, kind: 'fulfillment' });
  if (!state) throw ApiError.badRequest('Invalid state for this tenant/kind');

  if (req.auth.role && !state.allowedRoles.includes(req.auth.role)) {
    throw ApiError.forbidden(`Tu rol no puede pasar pedidos a «${state.name}». El dueño lo habilita en Workflow.`);
  }

  await applyFulfillmentState(order, state, req.auth.tenantId, req.auth.userId, { link });
  await order.save();

  await notifyStateChange(order, state, req.auth.tenantId);
  res.json({ order });
});

/** Aviso al cliente, si el estado lo pide. Best-effort: no bloquea la respuesta. */
async function notifyStateChange(
  order: { customer: Types.ObjectId; trackingToken: string },
  state: { notifyCustomer: boolean; name: string },
  tenantId: string,
) {
  if (!state.notifyCustomer) return;
  const [customer, session] = await Promise.all([
    Customer.findById(order.customer).select('name phone').lean(),
    sessionForTenant(tenantId),
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

/**
 * POST /orders/:id/cancel — cancela el pedido, con su motivo en el historial.
 *
 * Es la forma de sacar un pedido de circulación: vuelve el stock y la reserva
 * de la campaña, y el pedido queda a la vista con todo lo que pasó. Eliminar
 * borra hasta el rastro, por eso queda solo para el dueño y el administrador.
 *
 * No exige que el rol esté habilitado en el estado de cancelación: cancelar
 * es una acción del día a día del personal, no un paso del recorrido.
 */
export const cancelOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const reason = String(req.body?.reason ?? '').trim();

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.createdVia === 'pos') {
    throw ApiError.conflict('Una venta de mostrador se anula desde la caja.');
  }

  const states = await WorkflowState.find({ tenant: req.auth.tenantId, kind: 'fulfillment' }).sort({ position: 1 });
  if (states.find((s) => s._id.equals(order.fulfillmentState))?.isCancellation) {
    throw ApiError.conflict('Este pedido ya está cancelado.');
  }
  const cancelled = states.find((s) => s.isCancellation);
  if (!cancelled) throw ApiError.badRequest('Tu workflow necesita un estado de cancelación.');

  await applyFulfillmentState(order, cancelled, req.auth.tenantId, req.auth.userId, {
    note: reason || undefined,
  });
  await order.save();

  await notifyStateChange(order, cancelled, req.auth.tenantId);
  res.json({ order });
});

/**
 * POST /orders/:id/refunds — registra dinero devuelto al cliente.
 *
 * Normalmente después de cancelar, pero no lo exige: también sirve para
 * devolver una parte (cobraste de más, faltó un producto).
 */
export const refundOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const method = parseMethod(req.body?.method);
  const note = String(req.body?.note ?? '').trim() || undefined;
  const amount = Math.round(Number(req.body?.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw ApiError.badRequest('El monto debe ser mayor a 0');

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.createdVia === 'pos') {
    throw ApiError.conflict('Una venta de mostrador se anula desde la caja: ahí sale el dinero del cuadre.');
  }

  const available = Math.round((validatedTotal(order.payments) - refundedTotal(order.refunds)) * 100) / 100;
  if (amount > available + 0.001) {
    throw ApiError.badRequest(
      available <= 0
        ? 'No hay dinero cobrado para devolver en este pedido.'
        : `Solo se puede devolver lo cobrado: S/ ${available.toFixed(2)}.`,
    );
  }

  // Si sale en efectivo con la caja abierta, sale de esa caja.
  const openSession = method
    ? await CashSession.findOne({ tenant: req.auth.tenantId, status: 'open' }).select('_id').lean()
    : null;

  order.refunds.push({
    amount,
    method,
    note,
    at: new Date(),
    by: req.auth.userId ? new Types.ObjectId(req.auth.userId) : undefined,
    cashSession: openSession?._id,
  });
  await syncPaymentState(order, req.auth.tenantId, req.auth.userId);
  await order.save();

  res.json({ order });
});

/**
 * Busca un pago por su id. Acepta también 'advance' / 'balance', que es como
 * se identificaban antes de que un pedido pudiera tener más de un pago de
 * cada tipo: así un panel viejo abierto en otra pestaña no se rompe.
 */
function findPaymentIndex(payments: { _id?: Types.ObjectId; kind: string }[], ref: string) {
  if (ref === 'advance' || ref === 'balance') return payments.findIndex((p) => p.kind === ref);
  return payments.findIndex((p) => p._id?.toString() === ref);
}

function parseMethod(raw: unknown): PaymentMethodKind | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!PAYMENT_METHOD_KINDS.includes(raw as PaymentMethodKind)) {
    throw ApiError.badRequest('Medio de pago no válido');
  }
  return raw as PaymentMethodKind;
}

/**
 * POST /orders/:id/payments — registra un pago.
 *
 * Un pedido puede tener los pagos que haga falta: antes había exactamente un
 * «adelanto» y un «saldo», y quien pagaba en tres partes no tenía cómo
 * registrarse. Si es adelanto o saldo se deduce del monto, no se pregunta.
 */
export const registerPayment = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { amount: rawAmount, proofImageUrl, note } = req.body as {
    amount: number;
    proofImageUrl?: string;
    note?: string;
  };
  const method = parseMethod(req.body?.method);
  const amount = Math.round(Number(rawAmount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw ApiError.badRequest('El monto debe ser mayor a 0');

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  /*
   * No se cobra de más. Lo que está en revisión cuenta como comprometido: si
   * no, al validar ese comprobante el pedido quedaría pagado dos veces.
   */
  const paid = Math.round((validatedTotal(order.payments) - refundedTotal(order.refunds)) * 100) / 100;
  const inReview = pendingTotal(order.payments);
  const room = Math.round((order.totalAmount - paid - inReview) * 100) / 100;
  if (amount > room + 0.001) {
    throw ApiError.badRequest(
      room <= 0
        ? inReview > 0
          ? 'No queda saldo por cobrar: hay un comprobante en revisión que lo cubre. Valídalo o recházalo primero.'
          : 'Este pedido ya está pagado completo.'
        : `El pago supera lo que falta cobrar (S/ ${room.toFixed(2)}).`,
    );
  }

  /*
   * Si hay una caja abierta y se dijo cómo pagó, el pago entra a esa caja: el
   * saldo que alguien paga en efectivo al recoger también está en el cajón.
   */
  const openSession = method
    ? await CashSession.findOne({ tenant: req.auth.tenantId, status: 'open' }).select('_id').lean()
    : null;

  order.payments.push({
    kind: kindForNewPayment(paid, amount, order.totalAmount),
    amount,
    proofImageUrl: proofImageUrl || undefined,
    note: note?.trim() || undefined,
    // Lo registra el negocio, así que no hay nada que validar.
    validated: true,
    validatedAt: new Date(),
    registeredAt: new Date(),
    registeredBy: req.auth.userId ? new Types.ObjectId(req.auth.userId) : undefined,
    method,
    cashSession: openSession?._id,
  });

  // Ya hay un pago nuevo: lo rechazado quedó atrás.
  order.paymentRejectedAt = undefined;
  await syncPaymentState(order, req.auth.tenantId, req.auth.userId);

  await order.save();
  res.json({ order });
});

/**
 * El negocio confirma que el comprobante que subió el cliente efectivamente
 * llegó. Recién aquí cuenta como pagado y puede mover el estado de pago.
 * Puede decir de paso por dónde llegó (Yape, Plin…), que el cliente no indica.
 */
export const validatePayment = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const method = parseMethod(req.body?.method);

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  const idx = findPaymentIndex(order.payments, String(req.params.paymentId));
  if (idx === -1) throw ApiError.notFound('No encontramos ese pago en el pedido');
  const payment = order.payments[idx];
  if (payment.validated) throw ApiError.conflict('Ese pago ya está validado');

  payment.validated = true;
  payment.validatedAt = new Date();
  if (method) payment.method = method;
  order.paymentRejectedAt = undefined;

  await syncPaymentState(order, req.auth.tenantId, req.auth.userId);
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

/**
 * DELETE /orders/:id/payments/:paymentId — quita un pago.
 *
 * Sobre un comprobante sin validar es rechazarlo: se le avisa al cliente para
 * que lo regularice. Sobre uno validado es corregir un error de carga, y no
 * se avisa a nadie.
 */
export const deletePayment = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const order = await Order.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!order) throw ApiError.notFound('Order not found');

  // Una venta de mostrador se cobró en el momento: se anula entera, desde la caja.
  if (order.createdVia === 'pos') {
    throw ApiError.conflict('Los pagos de una venta de mostrador no se borran: anula la venta desde la caja.');
  }

  const idx = findPaymentIndex(order.payments, String(req.params.paymentId));
  if (idx === -1) throw ApiError.notFound('No encontramos ese pago en el pedido');

  /*
   * Rechazar un comprobante del cliente lo puede hacer quien valida, que es
   * cualquiera del equipo. Quitar un pago ya cobrado cambia lo que entró a la
   * caja: eso queda para el dueño y el administrador.
   */
  if (order.payments[idx].validated !== false && !['owner', 'admin'].includes(req.auth.role ?? '')) {
    throw ApiError.forbidden('Solo el dueño o un administrador pueden quitar un pago ya cobrado.');
  }

  const [removed] = order.payments.splice(idx, 1);

  // Clean up proof image from R2 (best-effort).
  if (removed.proofImageUrl) await deleteByUrl(removed.proofImageUrl);

  await syncPaymentState(order, req.auth.tenantId, req.auth.userId);

  // Queda constancia para el seguimiento: el pago borrado no la dejaría.
  if (removed.validated === false) order.paymentRejectedAt = new Date();

  await order.save();

  if (removed.validated === false) {
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

  // Borrarla haría desaparecer dinero de una caja que alguien va a contar.
  if (order.createdVia === 'pos') {
    throw ApiError.conflict('Las ventas de mostrador no se eliminan: anúlala desde la caja.');
  }

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
