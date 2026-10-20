import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth, requireTenant } from '../middleware/auth';
import { Subscription } from '../models/Subscription';
import { getEntitlements } from '../services/entitlements';

export const subscriptionRoutes = Router();

/**
 * GET /subscription/me
 *
 * Devuelve la suscripción y, aparte, los permisos ya resueltos.
 *
 * Lo segundo es lo que consume el panel. Antes el front leía
 * `subscription.plan.features` y resolvía por su cuenta, así que no veía las
 * excepciones del negocio: el superadmin regalaba una funcionalidad y la
 * pantalla la seguía escondiendo.
 */
subscriptionRoutes.get(
  '/me',
  requireAuth,
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = req.auth!.tenantId!;

    const [sub, entitlements] = await Promise.all([
      Subscription.findOne({ tenant: tenantId })
        .populate('plan', 'name code price priceYearly features')
        .lean(),
      getEntitlements(tenantId),
    ]);

    res.json({
      subscription: sub ?? null,
      features: entitlements.features,
      status: entitlements.status,
      readOnly: entitlements.readOnly,
      plan: entitlements.plan,
      overridden: entitlements.overridden,
      expiresAt: entitlements.expiresAt,
    });
  }),
);
