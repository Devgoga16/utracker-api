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
  deleteTenant,
} from '../controllers/superadmin.controller';
import {
  listAllBills,
  generateMonthlyBills,
  updateBill,
} from '../controllers/billing.controller';
import { whatsappStatus, whatsappTest } from '../controllers/whatsapp.controller';

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
// Irreversible y en cascada: exige el nombre del negocio en el body.
superadminRoutes.delete('/tenants/:id', deleteTenant);

superadminRoutes.get('/bills', listAllBills);
superadminRoutes.post('/bills/generate', generateMonthlyBills);
superadminRoutes.patch('/bills/:id', updateBill);

// El navegador nunca habla con el bot: la API key se queda acá.
superadminRoutes.get('/whatsapp/status', whatsappStatus);
superadminRoutes.post('/whatsapp/test', whatsappTest);
