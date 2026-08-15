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
  toggleSubscription,
} from '../controllers/superadmin.controller';
import {
  listAllBills,
  generateMonthlyBills,
  updateBill,
} from '../controllers/billing.controller';

export const superadminRoutes = Router();

superadminRoutes.use(requireAuth, requireSuperAdmin);

superadminRoutes.get('/stats', getStats);

superadminRoutes.get('/plans', listPlans);
superadminRoutes.post('/plans', createPlan);
superadminRoutes.put('/plans/:id', updatePlan);
superadminRoutes.delete('/plans/:id', deletePlan);

superadminRoutes.get('/tenants', listTenants);
superadminRoutes.patch('/tenants/:id/subscription', assignSubscription);
superadminRoutes.patch('/tenants/:id/toggle', toggleSubscription);

superadminRoutes.get('/bills', listAllBills);
superadminRoutes.post('/bills/generate', generateMonthlyBills);
superadminRoutes.patch('/bills/:id', updateBill);
