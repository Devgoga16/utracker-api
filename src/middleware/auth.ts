import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { Membership, MembershipRole } from '../models/Membership';
import { findActiveAccess } from '../models/SupportAccess';
import { logSupportAction } from '../services/systemLog';

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing bearer token');
  }

  const token = header.slice('Bearer '.length);
  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub };
    next();
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }
}

/**
 * Deja constancia de lo que soporte cambió dentro de un negocio ajeno.
 *
 * Se engancha al final de la respuesta para registrar solo lo que de verdad
 * se aplicó: una request que terminó en 400 no cambió nada y no merece una
 * línea en la bitácora.
 */
function auditSupportWrite(req: Request, res: Response) {
  if (req.method === 'GET') return;

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    logSupportAction({
      message: `Soporte ejecutó ${req.method} ${req.originalUrl}`,
      action: `${req.method} ${req.originalUrl}`,
      statusCode: res.statusCode,
      tenant: req.auth?.tenantId,
      user: req.auth?.userId,
      context: { body: req.body, params: req.params, accessId: req.auth?.support?.accessId },
    });
  });
}

// Resolves tenant from X-Tenant-Id header, requires an active membership.
export const requireTenant = asyncHandler(async (req, res, next) => {
  if (!req.auth) throw ApiError.unauthorized();

  const tenantId = req.header('X-Tenant-Id') ?? (req.params.tenantId ? String(req.params.tenantId) : undefined);
  if (!tenantId) throw ApiError.badRequest('Missing tenant context (X-Tenant-Id header)');

  const membership = await Membership.findOne({
    tenant: tenantId,
    user: req.auth.userId,
    isActive: true,
  });

  if (membership) {
    req.auth.tenantId = tenantId;
    req.auth.role = membership.role;
    return next();
  }

  /**
   * Sin membresía queda una vía más: un acceso de soporte vigente.
   *
   * Es lo que permite entrar al panel del negocio a diagnosticar sin pedirle
   * la contraseña al dueño ni dejarse un usuario fantasma adentro. Tiene
   * vencimiento y motivo, y todo lo que escriba queda firmado como soporte.
   */
  const access = await findActiveAccess(tenantId, req.auth.userId);
  if (!access) throw ApiError.forbidden('No access to this tenant');

  if (!access.canWrite && req.method !== 'GET') {
    throw ApiError.forbidden(
      'Tu acceso de soporte es de solo lectura. Pedí uno con permiso de cambios para hacer esto.',
    );
  }

  req.auth.tenantId = tenantId;
  // Soporte trabaja con el alcance del dueño: entró justamente a lo que el dueño no pudo resolver.
  req.auth.role = 'owner';
  req.auth.support = { accessId: access._id.toString(), canWrite: access.canWrite };

  auditSupportWrite(req, res);
  next();
});

export function requireRole(...roles: MembershipRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth?.role || !roles.includes(req.auth.role)) {
      throw ApiError.forbidden('Insufficient role for this action');
    }
    next();
  };
}
