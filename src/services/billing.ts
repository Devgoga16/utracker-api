import { Types } from 'mongoose';
import { Bill } from '../models/Bill';
import { referralDiscountsFor } from './referrals';

/**
 * Crea la cuenta de un mes con los descuentos que correspondan.
 *
 * Es el único lugar que crea cuentas: el cierre de mes y la asignación de plan
 * pasan por aquí, así ninguno se olvida de los descuentos por referidos.
 * Una cuenta que los descuentos dejan en S/0 nace pagada: no hay nada que
 * comprobar.
 */
export async function createBill(input: {
  tenant: Types.ObjectId;
  subscription: Types.ObjectId;
  plan: { name: string; code?: string; price: number };
  period: string;
  dueDate: Date;
}) {
  const { amount, discounts } = await referralDiscountsFor(input.tenant, input.plan);
  const free = amount === 0;

  return Bill.create({
    tenant: input.tenant,
    subscription: input.subscription,
    period: input.period,
    planName: input.plan.name,
    amount,
    baseAmount: input.plan.price,
    discounts: discounts.length ? discounts : undefined,
    dueDate: input.dueDate,
    status: free ? 'paid' : 'pending',
    paidAt: free ? new Date() : undefined,
    notes: free ? 'Cubierta por descuentos' : undefined,
  });
}
