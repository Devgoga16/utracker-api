import { Request, Response } from 'express';
import { Order } from '../models/Order';
import { Tenant } from '../models/Tenant';
import { WorkflowState } from '../models/WorkflowState';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * Public order tracking. No auth: the token in the URL is the credential, so the
 * payload is built field by field -- never spread the order document, or internal
 * notes, driver identity and cost data leak to anyone holding the link.
 */
export const trackOrder = asyncHandler(async (req: Request, res: Response) => {
  const order = await Order.findOne({ trackingToken: String(req.params.token) })
    .populate('fulfillmentState paymentState')
    .populate({ path: 'items.product', select: 'images' })
    .lean();

  if (!order) throw ApiError.notFound('No encontramos este pedido');

  const [tenant, states] = await Promise.all([
    Tenant.findById(order.tenant).lean(),
    WorkflowState.find({ tenant: order.tenant, kind: 'fulfillment' }).sort({ position: 1 }).lean(),
  ]);

  const current = order.fulfillmentState as unknown as { _id: unknown; name: string; color: string; icon?: string } | null;
  const payment = order.paymentState as unknown as { name: string; color: string; icon?: string } | null;
  const currentId = current?._id?.toString();

  // Most recent timestamp per fulfillment state, from the frozen history.
  const reachedAt = new Map<string, string>();
  for (const entry of order.stateHistory) {
    if (entry.kind !== 'fulfillment') continue;
    reachedAt.set(entry.state.toString(), entry.changedAt.toISOString());
  }

  const isCancelled = states.some((s) => s._id.toString() === currentId && s.isCancellation);

  const steps = states
    // A cancellation step listed as "upcoming" would alarm the customer for no reason.
    .filter((s) => !s.isCancellation || s._id.toString() === currentId)
    .map((s) => {
      const id = s._id.toString();
      return {
        name: s.name,
        color: s.color,
        icon: s.icon,
        vibrant: s.vibrant,
        current: id === currentId,
        done: reachedAt.has(id) && id !== currentId,
        at: reachedAt.get(id) ?? null,
      };
    });

  const advance = order.payments
    .filter((p) => p.kind === 'advance')
    .reduce((sum, p) => sum + p.amount, 0);
  const balance = order.payments
    .filter((p) => p.kind === 'balance')
    .reduce((sum, p) => sum + p.amount, 0);
  const totalPaid = advance + balance;
  const remaining = Math.max(0, order.totalAmount - totalPaid);

  res.json({
    tenant: { name: tenant?.name, logoUrl: tenant?.logoUrl },
    createdAt: order.createdAt,
    type: order.type,
    isCancelled,
    items: order.items.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      variant: i.variant,
      specs: i.specs,
      images: (i.product as unknown as { images?: string[] } | null)?.images ?? [],
    })),
    totalAmount: order.totalAmount,
    payments: { advance, balance, totalPaid, remaining },
    fulfillmentLink: order.fulfillmentLink,
    currentState: current && { name: current.name, color: current.color, icon: current.icon },
    paymentState: payment && { name: payment.name, color: payment.color, icon: payment.icon },
    deliveryAddress: order.delivery?.address,
    steps,
  });
});
