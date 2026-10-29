import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { getMyReferrals, lookupReferral } from '../controllers/referral.controller';

export const referralRoutes = Router();

// Público: la página de registro muestra quién invitó.
referralRoutes.get('/lookup/:code', lookupReferral);
// El descuento cae en la cuenta del negocio: lo ve quien ve la suscripción.
referralRoutes.get('/me', requireAuth, requireTenant, requireRole('owner', 'admin'), getMyReferrals);
