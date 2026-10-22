import { Types } from 'mongoose';
import { IPaymentEntry, Order } from '../models/Order';
import { WorkflowState } from '../models/WorkflowState';
import { buildHistoryEntry } from './stateHistory';

/**
 * Las cuentas de un pedido, en un solo lugar.
 *
 * Antes cada pantalla sumaba a su manera —el seguimiento separaba adelanto de
 * saldo, el detalle sumaba todo, la boleta otra cosa— y era fácil que dos
 * vistas del mismo pedido no coincidieran.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

type PaymentLike = Pick<IPaymentEntry, 'amount' | 'validated'>;

/** Lo que el negocio ya confirmó que llegó. Es lo único que cuenta como pagado. */
export function validatedTotal(payments: PaymentLike[]): number {
  return round2(payments.reduce((s, p) => (p.validated === false ? s : s + p.amount), 0));
}

/** Comprobantes que mandó el cliente y nadie revisó todavía. */
export function pendingTotal(payments: PaymentLike[]): number {
  return round2(payments.reduce((s, p) => (p.validated === false ? s + p.amount : s), 0));
}

/**
 * El estado de pago que corresponde a lo cobrado.
 *
 * Se elige por las marcas del estado y no por su nombre ni su posición, así
 * funciona aunque el negocio los haya renombrado:
 *
 *   nada cobrado          → el inicial ("Pendiente")
 *   algo, no todo         → uno intermedio ("Parcial")
 *   todo                  → el final que no es de cancelación ("Pagado")
 */
export async function resolvePaymentState(tenantId: string, totalPaid: number, totalAmount: number) {
  const states = await WorkflowState.find({ tenant: tenantId, kind: 'payment' }).sort({ position: 1 });
  const initial = states.find((s) => s.isInitial) ?? null;

  if (totalPaid >= totalAmount) {
    return states.find((s) => s.isFinal && !s.isCancellation) ?? states.find((s) => s.isFinal) ?? initial;
  }
  if (totalPaid > 0) {
    return states.find((s) => !s.isInitial && !s.isFinal && !s.isCancellation) ?? initial;
  }
  return initial;
}

/** Lo que ya se le devolvió al cliente. */
export function refundedTotal(refunds: { amount: number }[] | undefined): number {
  return round2((refunds ?? []).reduce((s, r) => s + r.amount, 0));
}

/**
 * Pone el estado de pago del pedido al día con sus pagos y devoluciones, y
 * deja constancia en el historial si cambió. Es lo que hay que llamar después
 * de tocar `payments` o `refunds`.
 *
 * Si se devolvió todo lo cobrado, el pedido pasa al estado de pago de
 * cancelación («Reembolsado»). Si se devolvió una parte, cuenta lo que quedó.
 */
export async function syncPaymentState(
  order: {
    totalAmount: number;
    payments: PaymentLike[];
    refunds?: { amount: number }[];
    paymentState: Types.ObjectId;
    stateHistory: { push: (entry: ReturnType<typeof buildHistoryEntry>) => unknown };
  },
  tenantId: string,
  userId?: string,
) {
  const refunded = refundedTotal(order.refunds);
  const kept = round2(validatedTotal(order.payments) - refunded);

  let next = null;
  if (refunded > 0 && kept <= 0) {
    next = await WorkflowState.findOne({ tenant: tenantId, kind: 'payment', isCancellation: true }).sort({
      position: 1,
    });
  }
  next ??= await resolvePaymentState(tenantId, Math.max(0, kept), order.totalAmount);
  if (next && !next._id.equals(order.paymentState)) {
    order.paymentState = next._id;
    order.stateHistory.push(buildHistoryEntry(next, userId));
  }
}

/**
 * Cómo se llama un pago nuevo: «adelanto» si todavía deja saldo, «saldo» si
 * lo completa. El dueño ya no lo elige: era la pregunta que más confundía
 * («¿esto es adelanto o saldo?») y la respuesta siempre se deduce sola.
 */
export function kindForNewPayment(alreadyPaid: number, amount: number, total: number): 'advance' | 'balance' {
  return alreadyPaid + amount >= total ? 'balance' : 'advance';
}

/**
 * Les da id a los pagos que no lo tienen —los registrados antes de que un
 * pedido pudiera tener varios— y lo guarda.
 *
 * Se hace al abrir el pedido, que es donde se valida o se quita un pago: así
 * no hace falta una migración, y el id que ve el panel es el mismo que
 * encuentra el servidor cuando le piden actuar sobre ese pago.
 */
export async function ensurePaymentIds(orderId: string, tenantId: string) {
  const stale = await Order.findOne({
    _id: orderId,
    tenant: tenantId,
    payments: { $elemMatch: { _id: { $exists: false } } },
  })
    .select('payments')
    .lean();
  if (!stale) return;

  await Order.updateOne(
    { _id: stale._id },
    { $set: { payments: stale.payments.map((p) => ({ ...p, _id: p._id ?? new Types.ObjectId() })) } },
  );
}
