import { Types } from 'mongoose';
import { Tenant } from '../models/Tenant';
import { Bill, IBillDiscount } from '../models/Bill';
import { Subscription } from '../models/Subscription';
import { Plan } from '../models/Plan';
import { effectiveStatus } from './entitlements';

/**
 * Programa de referidos.
 *
 * - El que invita paga S/10 menos al mes por cada negocio invitado que siga
 *   activo, hasta llegar a S/0. Nunca se le devuelve plata.
 * - El invitado tiene sus primeros meses el plan Negocio al precio de Emprende.
 *
 * Todo se resuelve al generar la cuenta del mes: no hay saldos ni créditos
 * guardados que se puedan desincronizar. Si el invitado deja de pagar, el
 * descuento del que lo invitó desaparece solo en la cuenta siguiente.
 */
export const REFERRAL_MONTHLY_DISCOUNT = 10;
export const REFERRED_PROMO_MONTHS = 2;
/** El plan que el invitado tiene a precio rebajado, y el precio que paga por él. */
export const REFERRED_PROMO_PLAN = 'negocio';
export const REFERRED_PROMO_PRICE_PLAN = 'emprende';

export type ReferralStatus = 'pending' | 'active' | 'inactive' | 'rejected';

/** "Pastelería Doña Ana" (slug pasteleria-dona-ana) → "PASTELERIADO" */
function baseCodeFrom(slug: string): string {
  const clean = slug.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return clean || 'NEGOCIO';
}

/** El código del negocio; lo crea la primera vez que se pide. */
export async function ensureReferralCode(tenantId: string | Types.ObjectId): Promise<string> {
  const tenant = await Tenant.findById(tenantId).select('slug referralCode');
  if (!tenant) throw new Error('Tenant not found');
  if (tenant.referralCode) return tenant.referralCode;

  const base = baseCodeFrom(tenant.slug);
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = attempt === 0 ? base : `${base}${Math.floor(10 + Math.random() * 90)}`;
    if (await Tenant.exists({ referralCode: code })) continue;
    try {
      tenant.referralCode = code;
      await tenant.save();
      return code;
    } catch (err) {
      // Otro negocio tomó el mismo código entre la consulta y el guardado.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  throw new Error('No se pudo generar un código de invitación');
}

/** El negocio dueño de un código, si existe y sigue activo. */
export async function findReferrerByCode(code: string | undefined | null) {
  const clean = code?.trim().toUpperCase();
  if (!clean || !/^[A-Z0-9]{2,16}$/.test(clean)) return null;
  return Tenant.findOne({ referralCode: clean, isActive: true }).select('name slug logoUrl').lean();
}

/**
 * En qué está cada invitado de una lista de negocios.
 *
 * Activo = pagó al menos una cuenta, no debe ninguna vencida y su suscripción
 * sigue en pie. Así un negocio que se registra y nunca paga no regala nada.
 */
export async function referralStatuses(
  referred: { _id: Types.ObjectId; isActive: boolean; referralRejectedAt?: Date }[],
): Promise<Map<string, ReferralStatus>> {
  const ids = referred.map((t) => t._id);
  const [paid, overdue, subs] = await Promise.all([
    Bill.distinct('tenant', { tenant: { $in: ids }, status: 'paid' }),
    Bill.distinct('tenant', { tenant: { $in: ids }, status: 'overdue' }),
    Subscription.find({ tenant: { $in: ids } }).select('tenant status expiresAt').lean(),
  ]);
  const paidSet = new Set(paid.map(String));
  const overdueSet = new Set(overdue.map(String));
  const subMap = new Map(subs.map((s) => [String(s.tenant), s]));

  const result = new Map<string, ReferralStatus>();
  for (const t of referred) {
    const id = String(t._id);
    const sub = subMap.get(id);
    const subOk =
      sub && !['suspended', 'expired'].includes(effectiveStatus(sub.status, sub.expiresAt ?? null));

    let status: ReferralStatus;
    if (t.referralRejectedAt) status = 'rejected';
    else if (!paidSet.has(id)) status = 'pending';
    else if (t.isActive && subOk && !overdueSet.has(id)) status = 'active';
    else status = 'inactive';
    result.set(id, status);
  }
  return result;
}

/**
 * Los descuentos de la cuenta de un negocio para un plan dado.
 *
 * Se aplican en orden y nunca bajan de cero: si los referidos ya cubren todo
 * el plan, los que sobran no aparecen.
 */
export async function referralDiscountsFor(
  tenantId: Types.ObjectId,
  plan: { code?: string; price: number },
): Promise<{ amount: number; discounts: IBillDiscount[] }> {
  const tenant = await Tenant.findById(tenantId).select('referredBy referralRejectedAt').lean();
  const discounts: IBillDiscount[] = [];
  let remaining = plan.price;

  // El invitado: sus primeras cuentas del plan Negocio, a precio Emprende.
  if (tenant?.referredBy && !tenant.referralRejectedAt && plan.code === REFERRED_PROMO_PLAN) {
    const previous = await Bill.countDocuments({ tenant: tenantId });
    if (previous < REFERRED_PROMO_MONTHS) {
      const cheaper = await Plan.findOne({ code: REFERRED_PROMO_PRICE_PLAN }).select('name price').lean();
      const diff = cheaper ? Math.max(0, plan.price - cheaper.price) : 0;
      if (diff > 0) {
        discounts.push({
          label: `Invitado: plan Negocio a precio ${cheaper!.name} (mes ${previous + 1} de ${REFERRED_PROMO_MONTHS})`,
          amount: diff,
        });
        remaining -= diff;
      }
    }
  }

  // El que invita: S/10 por cada invitado activo.
  if (remaining > 0) {
    const referred = await Tenant.find({ referredBy: tenantId })
      .select('name isActive referralRejectedAt createdAt')
      .sort({ createdAt: 1 })
      .lean();
    if (referred.length) {
      const statuses = await referralStatuses(referred);
      for (const t of referred) {
        if (remaining <= 0) break;
        if (statuses.get(String(t._id)) !== 'active') continue;
        const amount = Math.min(REFERRAL_MONTHLY_DISCOUNT, remaining);
        discounts.push({ label: `Invitaste a ${t.name}`, amount });
        remaining -= amount;
      }
    }
  }

  return { amount: Math.max(0, Math.round(remaining * 100) / 100), discounts };
}
