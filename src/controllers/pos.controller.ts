import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Order, PAYMENT_METHOD_KINDS, PaymentMethodKind } from '../models/Order';
import { CashSession, ICashSession, ICashSummary } from '../models/CashSession';
import { Customer } from '../models/Customer';
import { Product } from '../models/Product';
import { WorkflowState } from '../models/WorkflowState';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { buildHistoryEntry } from '../services/stateHistory';
import { applyFulfillmentState, syncOrderStock } from '../services/orderStock';
import { resolvePaymentState } from '../services/payments';

/**
 * Punto de venta: la venta de mostrador y la caja donde entra la plata.
 *
 * Una venta es un pedido más —así aparece en finanzas, descuenta inventario y
 * tiene su ticket sin duplicar nada—, pero nace entregado y pagado, en un solo
 * paso. No emite comprobantes electrónicos: el ticket es una constancia
 * interna, igual que la boleta de los pedidos.
 */

/**
 * El cliente de las ventas en las que nadie da su nombre, que son casi todas.
 * El pedido exige un cliente, y crear uno por cada venta anónima llenaría la
 * lista de clientes de «Cliente» repetidos.
 */
const WALK_IN_PHONE = 'mostrador';
const WALK_IN_NAME = 'Cliente de mostrador';

const round2 = (n: number) => Math.round(n * 100) / 100;

function userRef(req: Request) {
  return req.auth?.userId ? new Types.ObjectId(req.auth.userId) : undefined;
}

async function openSessionFor(tenantId: string) {
  return CashSession.findOne({ tenant: tenantId, status: 'open' });
}

/**
 * El cuadre de una caja, calculado desde los pagos que entraron en ella.
 *
 * Cuenta tanto las ventas de mostrador como los pagos de pedidos que se
 * cobraron con la caja abierta: el saldo que alguien paga al recoger también
 * está en el cajón.
 */
async function summarize(session: ICashSession): Promise<ICashSummary> {
  const [byMethodRows, salesRows, refundRows] = await Promise.all([
    Order.aggregate<{ _id: PaymentMethodKind | null; amount: number }>([
      { $match: { tenant: session.tenant, 'payments.cashSession': session._id } },
      { $unwind: '$payments' },
      { $match: { 'payments.cashSession': session._id } },
      { $group: { _id: '$payments.method', amount: { $sum: '$payments.amount' } } },
    ]),
    Order.aggregate<{ count: number; total: number }>([
      {
        $match: {
          tenant: session.tenant,
          cashSession: session._id,
          createdVia: 'pos',
          voidedAt: { $exists: false },
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalAmount' } } },
    ]),
    // Devoluciones a clientes que salieron de esta caja.
    Order.aggregate<{ _id: PaymentMethodKind | null; amount: number }>([
      { $match: { tenant: session.tenant, 'refunds.cashSession': session._id } },
      { $unwind: '$refunds' },
      { $match: { 'refunds.cashSession': session._id } },
      { $group: { _id: '$refunds.method', amount: { $sum: '$refunds.amount' } } },
    ]),
  ]);

  const byMethod: Partial<Record<PaymentMethodKind, number>> = {};
  for (const row of byMethodRows) {
    const method = row._id ?? 'other';
    byMethod[method] = round2((byMethod[method] ?? 0) + row.amount);
  }
  let refunds = 0;
  for (const row of refundRows) {
    const method = row._id ?? 'other';
    byMethod[method] = round2((byMethod[method] ?? 0) - row.amount);
    refunds = round2(refunds + row.amount);
  }

  const cashIn = round2(
    session.movements.filter((m) => m.type === 'in').reduce((s, m) => s + m.amount, 0),
  );
  const cashOut = round2(
    session.movements.filter((m) => m.type === 'out').reduce((s, m) => s + m.amount, 0),
  );

  return {
    salesCount: salesRows[0]?.count ?? 0,
    salesTotal: round2(salesRows[0]?.total ?? 0),
    byMethod,
    refunds,
    cashIn,
    cashOut,
    expectedCash: round2(session.openingAmount + (byMethod.cash ?? 0) + cashIn - cashOut),
  };
}

/** Las ventas de una caja, las anuladas incluidas: también son parte del turno. */
function salesOf(tenantId: string, sessionId: Types.ObjectId, limit = 200) {
  return Order.find({ tenant: tenantId, cashSession: sessionId, createdVia: 'pos' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('customer', 'name phone')
    .populate('createdBy', 'name')
    .lean();
}

/* ─────────────────────────── Caja ─────────────────────────── */

/** GET /pos/session — la caja abierta, con su cuadre y sus ventas. Null si no hay. */
export const getCurrentSession = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  const session = await CashSession.findOne({ tenant: tenantId, status: 'open' }).populate(
    'openedBy',
    'name',
  );
  if (!session) {
    res.json({ session: null, summary: null, sales: [] });
    return;
  }

  const [summary, sales] = await Promise.all([summarize(session), salesOf(tenantId, session._id)]);
  res.json({ session, summary, sales });
});

/** POST /pos/session — abre la caja con el sencillo que hay en el cajón. */
export const openSession = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  const openingAmount = Number(req.body?.openingAmount ?? 0);
  if (!Number.isFinite(openingAmount) || openingAmount < 0) {
    throw ApiError.badRequest('El monto inicial no puede ser negativo');
  }

  try {
    const session = await CashSession.create({
      tenant: tenantId,
      openingAmount: round2(openingAmount),
      openedBy: userRef(req),
    });
    res.status(201).json({ session });
  } catch (err) {
    // El índice único: otra persona la abrió un instante antes.
    if ((err as { code?: number }).code === 11000) {
      throw ApiError.conflict('Ya hay una caja abierta. Recarga para verla.');
    }
    throw err;
  }
});

/** POST /pos/session/movements — plata que entra o sale del cajón sin ser una venta. */
export const addMovement = asyncHandler(async (req: Request, res: Response) => {
  const { type, amount, note } = req.body as { type: 'in' | 'out'; amount: number; note?: string };
  if (type !== 'in' && type !== 'out') throw ApiError.badRequest('Indica si entra o sale dinero');
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw ApiError.badRequest('El monto debe ser mayor a 0');
  // Un retiro sin motivo es justo lo que después nadie sabe explicar al cuadrar.
  if (type === 'out' && !note?.trim()) throw ApiError.badRequest('Indica el motivo del retiro');

  const session = await openSessionFor(req.auth!.tenantId!);
  if (!session) throw ApiError.conflict('No hay una caja abierta');

  session.movements.push({
    type,
    amount: round2(value),
    note: note?.trim() || undefined,
    at: new Date(),
    by: userRef(req),
  });
  await session.save();

  res.json({ session, summary: await summarize(session) });
});

/** POST /pos/session/close — se cuenta el efectivo y la caja queda cerrada con su cuadre. */
export const closeSession = asyncHandler(async (req: Request, res: Response) => {
  const { countedCash, note } = req.body as { countedCash: number; note?: string };
  const counted = Number(countedCash);
  if (!Number.isFinite(counted) || counted < 0) {
    throw ApiError.badRequest('Indica cuánto efectivo contaste');
  }

  const session = await openSessionFor(req.auth!.tenantId!);
  if (!session) throw ApiError.conflict('No hay una caja abierta');

  const summary = await summarize(session);

  session.status = 'closed';
  session.closedAt = new Date();
  session.closedBy = userRef(req);
  session.countedCash = round2(counted);
  session.difference = round2(counted - summary.expectedCash);
  session.closingNote = note?.trim() || undefined;
  session.summary = summary;
  await session.save();

  res.json({ session });
});

/** GET /pos/sessions — las cajas anteriores, para el dueño. */
export const listSessions = asyncHandler(async (req: Request, res: Response) => {
  const sessions = await CashSession.find({ tenant: req.auth!.tenantId })
    .sort({ openedAt: -1 })
    .limit(60)
    .populate('openedBy', 'name')
    .populate('closedBy', 'name')
    .select('-movements')
    .lean();
  res.json({ sessions });
});

/** GET /pos/sessions/:id — una caja con sus ventas y movimientos. */
export const getSession = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  if (!Types.ObjectId.isValid(String(req.params.id))) throw ApiError.notFound('Caja no encontrada');

  const session = await CashSession.findOne({ _id: req.params.id, tenant: tenantId })
    .populate('openedBy', 'name')
    .populate('closedBy', 'name')
    .populate('movements.by', 'name');
  if (!session) throw ApiError.notFound('Caja no encontrada');

  // Cerrada, vale lo que se congeló al cerrar; abierta, se calcula en el momento.
  const [summary, sales] = await Promise.all([
    session.status === 'closed' && session.summary ? session.summary : summarize(session),
    salesOf(tenantId, session._id),
  ]);
  res.json({ session, summary, sales });
});

/* ─────────────────────────── Ventas ─────────────────────────── */

interface SaleItemInput {
  productId?: string;
  name?: string;
  unitPrice?: number;
  quantity: number;
  variant?: string;
}

/** POST /pos/sales — cobra y entrega en un solo paso. */
export const createSale = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  const {
    items: itemsInput,
    method,
    received,
    customer: customerInput,
    note,
  } = req.body as {
    items: SaleItemInput[];
    method: PaymentMethodKind;
    received?: number;
    customer?: { name?: string; phone?: string };
    note?: string;
  };

  if (!itemsInput?.length) throw ApiError.badRequest('Agrega al menos un producto');
  if (!PAYMENT_METHOD_KINDS.includes(method)) throw ApiError.badRequest('Elige cómo pagó');

  const session = await openSessionFor(tenantId);
  if (!session) throw ApiError.conflict('Abre la caja para empezar a vender');

  /* Ítems: mismas reglas que un pedido, con el precio del catálogo por defecto. */
  const catalogIds = itemsInput.flatMap((i) => (i.productId ? [i.productId] : []));
  if (catalogIds.some((id) => !Types.ObjectId.isValid(id))) {
    throw ApiError.badRequest('Uno o más productos no existen');
  }
  const products = catalogIds.length
    ? await Product.find({ _id: { $in: catalogIds }, tenant: tenantId })
    : [];
  if (products.length !== new Set(catalogIds).size) {
    throw ApiError.badRequest('Uno o más productos no existen');
  }

  const items = itemsInput.map((input) => {
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw ApiError.badRequest('La cantidad debe ser un número entero mayor a 0');
    }
    if (input.unitPrice !== undefined && !(Number(input.unitPrice) >= 0)) {
      throw ApiError.badRequest('El precio no puede ser negativo');
    }

    if (!input.productId) {
      if (!input.name?.trim()) throw ApiError.badRequest('Un ítem libre necesita un nombre');
      if (input.unitPrice === undefined) throw ApiError.badRequest('Un ítem libre necesita un precio');
      return { name: input.name.trim(), unitPrice: round2(Number(input.unitPrice)), quantity };
    }

    const product = products.find((p) => p._id.toString() === input.productId)!;
    const variant = input.variant ? product.variants.find((v) => v.name === input.variant) : undefined;
    if (product.pricingMode === 'quoted' && input.unitPrice === undefined) {
      throw ApiError.badRequest(`"${product.name}" se cotiza: indica el precio`);
    }

    return {
      product: product._id,
      name: product.name,
      unitPrice: round2(
        input.unitPrice !== undefined
          ? Number(input.unitPrice)
          : product.price + (variant?.priceModifier ?? 0),
      ),
      quantity,
      variant: variant?.name,
    };
  });

  const totalAmount = round2(items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
  if (totalAmount <= 0) throw ApiError.badRequest('El total de la venta tiene que ser mayor a 0');

  // El vuelto solo existe en efectivo; con lo demás se cobra el monto exacto.
  let receivedCash: number | undefined;
  if (method === 'cash' && received !== undefined && received !== null) {
    receivedCash = round2(Number(received));
    if (!Number.isFinite(receivedCash) || receivedCash < totalAmount) {
      throw ApiError.badRequest('Lo recibido no alcanza para el total');
    }
  }

  /* Estados: entregado y pagado desde el primer momento. */
  const fulfillmentStates = await WorkflowState.find({ tenant: tenantId, kind: 'fulfillment' }).sort({
    position: 1,
  });
  const finals = fulfillmentStates.filter((s) => s.isFinal && !s.isCancellation);
  // Preferir el final que corresponde a un recojo: «Entregado», no «Enviado».
  const done =
    finals.find((s) => !s.appliesTo?.length || s.appliesTo.includes('pickup')) ?? finals[0];
  const paidState = await resolvePaymentState(tenantId, totalAmount, totalAmount);
  if (!done || !paidState) {
    throw ApiError.badRequest(
      'Tu workflow necesita un estado final (como «Entregado») para registrar ventas de mostrador',
    );
  }

  /* Cliente: el que dio su teléfono, o el de mostrador. */
  const phone = customerInput?.phone?.trim();
  const customer = phone
    ? await Customer.findOneAndUpdate(
        { tenant: tenantId, phone },
        { $setOnInsert: { tenant: tenantId, phone, name: customerInput?.name?.trim() || 'Cliente' } },
        { upsert: true, new: true },
      )
    : await Customer.findOneAndUpdate(
        { tenant: tenantId, phone: WALK_IN_PHONE },
        { $setOnInsert: { tenant: tenantId, phone: WALK_IN_PHONE, name: WALK_IN_NAME } },
        { upsert: true, new: true },
      );

  const by = userRef(req);
  const order = await Order.create({
    tenant: tenantId,
    customer: customer!._id,
    items,
    totalAmount,
    type: 'pickup',
    fulfillmentState: done._id,
    paymentState: paidState._id,
    stateHistory: [buildHistoryEntry(done, req.auth!.userId), buildHistoryEntry(paidState, req.auth!.userId)],
    payments: [
      {
        kind: 'balance',
        amount: totalAmount,
        method,
        received: receivedCash,
        cashSession: session._id,
        validated: true,
        validatedAt: new Date(),
        registeredAt: new Date(),
        registeredBy: by,
      },
    ],
    createdVia: 'pos',
    cashSession: session._id,
    notes: note?.trim() || undefined,
    createdBy: by,
  });

  /*
   * Inventario: sale del mostrador en ese momento, así que se descuenta ya,
   * sin esperar a un estado que descuente. No se bloquea la venta por falta de
   * stock: si el producto está en la mano del cliente, el que se equivocó es
   * el número del sistema, y la venta tiene que poder registrarse igual.
   */
  await syncOrderStock(order, tenantId, req.auth!.userId);

  await order.populate('customer', 'name phone');
  res.status(201).json({
    order,
    change: receivedCash !== undefined ? round2(receivedCash - totalAmount) : 0,
  });
});

/**
 * POST /pos/sales/:id/void — anula una venta: vuelve el stock y sale el dinero.
 *
 * Solo mientras su caja siga abierta. Anular una venta de una caja ya cerrada
 * cambiaría un cuadre que alguien ya contó y firmó; ahí lo que corresponde es
 * registrar la devolución como un retiro en la caja de hoy.
 */
export const voidSale = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  if (!Types.ObjectId.isValid(String(req.params.id))) throw ApiError.notFound('Venta no encontrada');

  const order = await Order.findOne({ _id: req.params.id, tenant: tenantId, createdVia: 'pos' });
  if (!order) throw ApiError.notFound('Venta no encontrada');
  if (order.voidedAt) throw ApiError.conflict('Esta venta ya está anulada');

  const session = order.cashSession ? await CashSession.findById(order.cashSession) : null;
  if (!session || session.status !== 'open') {
    throw ApiError.conflict(
      'La caja de esta venta ya se cerró. Si devolviste el dinero, regístralo como un retiro en la caja de hoy.',
    );
  }

  const cancelled = await WorkflowState.findOne({
    tenant: tenantId,
    kind: 'fulfillment',
    isCancellation: true,
  }).sort({ position: 1 });
  if (!cancelled) {
    throw ApiError.badRequest('Tu workflow necesita un estado de cancelación para anular ventas');
  }

  // Cancelada, la venta deja de tener stock descontado: vuelve todo.
  await applyFulfillmentState(order, cancelled, tenantId, req.auth!.userId, { note: 'Venta anulada' });

  // El dinero se devolvió: sin pagos, la caja y finanzas dejan de contarlo.
  order.payments.splice(0, order.payments.length);
  const unpaid = await resolvePaymentState(tenantId, 0, order.totalAmount);
  if (unpaid && !unpaid._id.equals(order.paymentState)) {
    order.paymentState = unpaid._id;
    order.stateHistory.push(buildHistoryEntry(unpaid, req.auth!.userId));
  }

  order.voidedAt = new Date();
  order.voidedBy = userRef(req);
  await order.save();

  res.json({ order, summary: await summarize(session) });
});
