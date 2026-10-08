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
  setTenantWhatsapp,
  getTenantWhatsapp,
} from '../controllers/superadmin.controller';
import {
  listAllBills,
  generateMonthlyBills,
  updateBill,
} from '../controllers/billing.controller';
import { whatsappConfig, whatsappTest } from '../controllers/whatsapp.controller';
import {
  getLogByRef,
  getTenantDetail,
  grantSupportAccess,
  listLogs,
  listSupportAccesses,
  logStats,
  revokeSupportAccess,
} from '../controllers/support.controller';
import {
  getTicketAsSupport,
  listAllTickets,
  replyAsSupport,
  ticketStats,
  updateTicketAsSupport,
} from '../controllers/ticket.controller';

export const superadminRoutes = Router();

superadminRoutes.use(requireAuth, requireSuperAdmin);

superadminRoutes.get('/stats', getStats);

superadminRoutes.get('/plans', listPlans);
superadminRoutes.post('/plans', createPlan);
superadminRoutes.put('/plans/:id', updatePlan);
superadminRoutes.delete('/plans/:id', deletePlan);

superadminRoutes.get('/tenants', listTenants);
// Ficha tecnica completa: configuracion, salud, miembros y ultimos errores.
superadminRoutes.get('/tenants/:id/detail', getTenantDetail);
superadminRoutes.patch('/tenants/:id/subscription', assignSubscription);
superadminRoutes.patch('/tenants/:id/toggle', toggleSubscription);
// Sesion de WhatsApp del negocio: propia o la compartida de uTracker.
superadminRoutes.get('/tenants/:id/whatsapp', getTenantWhatsapp);
superadminRoutes.patch('/tenants/:id/whatsapp', setTenantWhatsapp);
// Irreversible y en cascada: exige el nombre del negocio en el body.
superadminRoutes.delete('/tenants/:id', deleteTenant);

superadminRoutes.get('/bills', listAllBills);
superadminRoutes.post('/bills/generate', generateMonthlyBills);
superadminRoutes.patch('/bills/:id', updateBill);

// El navegador nunca habla con el bot: la API key se queda acá.
superadminRoutes.get('/whatsapp/config', whatsappConfig);
superadminRoutes.post('/whatsapp/test', whatsappTest);

/* ── Soporte tecnico ── */

// Entrar al panel del negocio con motivo y vencimiento, en vez de con la llave maestra.
superadminRoutes.post('/tenants/:id/support-access', grantSupportAccess);
superadminRoutes.get('/support-access', listSupportAccesses);
superadminRoutes.delete('/support-access/:id', revokeSupportAccess);

// Visor de logs. 'stats' y 'by-ref' van antes de cualquier ruta con parametro.
superadminRoutes.get('/logs/stats', logStats);
superadminRoutes.get('/logs/by-ref/:ref', getLogByRef);
superadminRoutes.get('/logs', listLogs);

// Bandeja de tickets.
superadminRoutes.get('/tickets/stats', ticketStats);
superadminRoutes.get('/tickets', listAllTickets);
superadminRoutes.get('/tickets/:id', getTicketAsSupport);
superadminRoutes.post('/tickets/:id/messages', replyAsSupport);
superadminRoutes.patch('/tickets/:id', updateTicketAsSupport);
