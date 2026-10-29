import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { Tenant } from '../models/Tenant';
import {
  REFERRAL_MONTHLY_DISCOUNT,
  REFERRED_PROMO_MONTHS,
  ensureReferralCode,
  findReferrerByCode,
  referralStatuses,
} from '../services/referrals';

/**
 * GET /referrals/lookup/:code — público.
 *
 * Lo usa la página de registro para decir «Te invitó Dominor». Solo devuelve
 * lo que ya se ve en la tienda pública del negocio.
 */
export const lookupReferral = asyncHandler(async (req: Request, res: Response) => {
  const referrer = await findReferrerByCode(req.params.code as string);
  if (!referrer) throw ApiError.notFound('Código de invitación no válido');
  res.json({
    name: referrer.name,
    logoUrl: referrer.logoUrl ?? null,
    promoMonths: REFERRED_PROMO_MONTHS,
  });
});

/** GET /referrals/me — el código del negocio y a quiénes invitó. */
export const getMyReferrals = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId!;
  const code = await ensureReferralCode(tenantId);

  const referred = await Tenant.find({ referredBy: tenantId })
    .select('name isActive referralRejectedAt createdAt')
    .sort({ createdAt: -1 })
    .lean();
  const statuses = await referralStatuses(referred);

  const referrals = referred.map((t) => ({
    _id: t._id,
    name: t.name,
    createdAt: t.createdAt,
    status: statuses.get(String(t._id))!,
  }));
  const activeCount = referrals.filter((r) => r.status === 'active').length;

  res.json({
    code,
    discountPerReferral: REFERRAL_MONTHLY_DISCOUNT,
    promoMonths: REFERRED_PROMO_MONTHS,
    activeCount,
    monthlyDiscount: activeCount * REFERRAL_MONTHLY_DISCOUNT,
    referrals,
  });
});

// ─── Superadmin ───────────────────────────────────────────────────────────────

/** GET /superadmin/referrals — todos los negocios que llegaron invitados. */
export const listAllReferrals = asyncHandler(async (_req: Request, res: Response) => {
  const referred = await Tenant.find({ referredBy: { $exists: true } })
    .select('name slug phone isActive referredBy referralRejectedAt createdAt')
    .populate('referredBy', 'name slug phone')
    .sort({ createdAt: -1 })
    .lean();
  const statuses = await referralStatuses(referred);

  res.json({
    referrals: referred.map((t) => ({
      _id: t._id,
      name: t.name,
      slug: t.slug,
      phone: t.phone ?? null,
      createdAt: t.createdAt,
      referrer: t.referredBy,
      status: statuses.get(String(t._id))!,
    })),
  });
});

/**
 * PATCH /superadmin/referrals/:tenantId — anula o restituye un referido.
 *
 * Para cuando el mismo dueño se invita con otro correo, o es una cuenta de
 * prueba. Las cuentas ya generadas no se tocan: corre desde la siguiente.
 */
export const setReferralRejected = asyncHandler(async (req: Request, res: Response) => {
  const { rejected } = req.body as { rejected?: boolean };
  if (typeof rejected !== 'boolean') throw ApiError.badRequest('rejected must be a boolean');

  const tenant = await Tenant.findOne({ _id: req.params.tenantId, referredBy: { $exists: true } });
  if (!tenant) throw ApiError.notFound('Ese negocio no llegó invitado');

  tenant.referralRejectedAt = rejected ? new Date() : undefined;
  await tenant.save();
  res.json({ rejected });
});
