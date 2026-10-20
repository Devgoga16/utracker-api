import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { User } from '../models/User';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { Membership } from '../models/Membership';
import { WorkflowState } from '../models/WorkflowState';
import { Campaign } from '../models/Campaign';
import { Invitation } from '../models/Invitation';
import { StoreApiKey } from '../models/StoreApiKey';
import { FEATURES, FlagKey, LimitKey } from '../config/features.catalog';
import { getEntitlements, limitOf } from '../services/entitlements';

export const requireSuperAdmin = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.userId) throw ApiError.unauthorized();

  const user = await User.findById(req.auth.userId).select('isSuperAdmin').lean();
  if (!user?.isSuperAdmin) throw ApiError.forbidden('Superadmin access required');

  next();
});

/**
 * Mensaje para cuando la suscripción no está en condiciones de operar.
 *
 * Se distingue vencida de suspendida porque lo que tiene que hacer el negocio
 * es distinto: una se arregla pagando, la otra hablando con nosotros.
 */
function subscriptionBlockMessage(status: string): string {
  if (status === 'expired') {
    return 'Tu suscripción venció. Registra el pago para volver a operar.';
  }
  return 'Tu suscripción está suspendida. Escríbenos para reactivarla.';
}

/**
 * Exige que el plan del negocio incluya una funcionalidad.
 *
 * La clave se valida contra el catálogo en tiempo de compilación: si se escribe
 * mal, no compila, en vez de dejar pasar todo silenciosamente.
 */
export function requireFeature(key: FlagKey) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw ApiError.unauthorized();

    const ent = await getEntitlements(tenantId);
    if (ent.readOnly) throw ApiError.forbidden(subscriptionBlockMessage(ent.status));

    if (!ent.features[key]) {
      throw ApiError.forbidden(`Tu plan no incluye: ${FEATURES[key].label}`);
    }

    next();
  });
}

/**
 * Bloquea escrituras cuando la suscripción está vencida o suspendida, sin
 * exigir ninguna funcionalidad en particular.
 *
 * Se usa donde no hay una clave que gatear pero igual no corresponde dejar
 * registrar: crear un pedido es el caso típico.
 */
export const requireWritable = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw ApiError.unauthorized();

    const ent = await getEntitlements(tenantId);
    if (ent.readOnly) throw ApiError.forbidden(subscriptionBlockMessage(ent.status));

    next();
  },
);

/**
 * Cómo se cuenta lo que ya tiene el negocio, por clave de límite.
 *
 * Vive junto al catálogo y no dentro del middleware para que agregar un límite
 * sea agregar la clave y su contador, y nada más.
 */
const COUNTERS: Record<LimitKey, (tenantId: string) => Promise<number>> = {
  maxOrdersPerMonth: (tenant) => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return Order.countDocuments({ tenant, createdAt: { $gte: start } });
  },
  maxCatalogItems: (tenant) => Product.countDocuments({ tenant, isActive: true }),
  maxWorkflowStates: (tenant) => WorkflowState.countDocuments({ tenant }),
  maxCampaigns: (tenant) =>
    Campaign.countDocuments({ tenant, status: { $in: ['draft', 'active'] } }),
  maxStoreKeys: (tenant) => StoreApiKey.countDocuments({ tenant, revokedAt: { $exists: false } }),
  /**
   * Miembros activos más invitaciones vivas.
   *
   * Si las pendientes no contaran, un plan de dos personas se esquiva mandando
   * veinte invitaciones: el límite saltaría cuando ya están todas aceptadas.
   */
  maxMembers: async (tenant) => {
    const [members, pending] = await Promise.all([
      Membership.countDocuments({ tenant, isActive: true }),
      Invitation.countDocuments({ tenant, status: 'pending', expiresAt: { $gt: new Date() } }),
    ]);
    return members + pending;
  },
};

/** Mensaje por clave, porque "límite de maxCatalogItems" no le dice nada a nadie. */
function limitReachedMessage(key: LimitKey, count: number, limit: number): string {
  const what = FEATURES[key].label.toLowerCase();
  return `Llegaste al límite de tu plan: ${count} de ${limit} ${what}. Sube de plan para ampliarlo.`;
}

/** Corta antes de crear si el negocio ya está en el tope de su plan. */
export function checkLimit(key: LimitKey) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw ApiError.unauthorized();

    const ent = await getEntitlements(tenantId);
    if (ent.readOnly) throw ApiError.forbidden(subscriptionBlockMessage(ent.status));

    const limit = limitOf(ent, key);
    if (limit === 0) return next(); // 0 = ilimitado

    const count = await COUNTERS[key](tenantId);
    if (count >= limit) throw ApiError.forbidden(limitReachedMessage(key, count, limit));

    next();
  });
}

/**
 * Para los controladores que necesitan decidir adentro, no en la ruta.
 *
 * Devuelve false en vez de lanzar: sirve para omitir una notificación o
 * recortar una respuesta, no para cortar la request.
 */
export async function tenantHasFeature(
  tenantId: string | undefined | null,
  key: FlagKey,
): Promise<boolean> {
  if (!tenantId) return false;
  const ent = await getEntitlements(String(tenantId));
  return Boolean(ent.features[key]);
}
