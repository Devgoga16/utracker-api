import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { requireFeature } from '../middleware/plan';
import {
  addMovement,
  closeSession,
  createSale,
  getCurrentSession,
  getSession,
  listSessions,
  openSession,
  voidSale,
} from '../controllers/pos.controller';

export const posRoutes = Router();

// Vende quien atiende: dueño, admin y staff. El repartidor no cobra en mostrador.
posRoutes.use(requireAuth, requireTenant, requireRole('owner', 'admin', 'staff'), requireFeature('pos'));

posRoutes.get('/session', getCurrentSession);
posRoutes.post('/session', openSession);
posRoutes.post('/session/movements', addMovement);
posRoutes.post('/session/close', closeSession);
posRoutes.post('/sales', createSale);

// Anular y revisar cajas pasadas es control, no atención: solo dueño y admin.
posRoutes.post('/sales/:id/void', requireRole('owner', 'admin'), voidSale);
posRoutes.get('/sessions', requireRole('owner', 'admin'), listSessions);
posRoutes.get('/sessions/:id', requireRole('owner', 'admin'), getSession);
