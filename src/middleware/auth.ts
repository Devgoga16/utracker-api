import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { Membership, MembershipRole } from '../models/Membership';

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

// Resolves tenant from X-Tenant-Id header, requires an active membership.
export const requireTenant = asyncHandler(async (req, _res, next) => {
  if (!req.auth) throw ApiError.unauthorized();

  const tenantId = req.header('X-Tenant-Id') ?? (req.params.tenantId ? String(req.params.tenantId) : undefined);
  if (!tenantId) throw ApiError.badRequest('Missing tenant context (X-Tenant-Id header)');

  const membership = await Membership.findOne({
    tenant: tenantId,
    user: req.auth.userId,
    isActive: true,
  });

  if (!membership) throw ApiError.forbidden('No access to this tenant');

  req.auth.tenantId = tenantId;
  req.auth.role = membership.role;
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
