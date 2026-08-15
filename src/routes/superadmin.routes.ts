import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireSuperAdmin } from '../middleware/plan';
import {
  getStats,
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
  listTenants,
  assignSubscription,
} from '../controllers/superadmin.controller';

export const superadminRoutes = Router();

superadminRoutes.use(requireAuth, requireSuperAdmin);

superadminRoutes.get('/stats', getStats);

superadminRoutes.get('/plans', listPlans);
superadminRoutes.post('/plans', createPlan);
superadminRoutes.put('/plans/:id', updatePlan);
superadminRoutes.delete('/plans/:id', deletePlan);

superadminRoutes.get('/tenants', listTenants);
superadminRoutes.patch('/tenants/:id/subscription', assignSubscription);
