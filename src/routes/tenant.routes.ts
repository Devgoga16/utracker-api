import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { createTenant, getWorkflow, listMyTenants, updateTenantSettings } from '../controllers/tenant.controller';
import {
  createState,
  deleteState,
  reorderStates,
  updateState,
} from '../controllers/workflow.controller';

export const tenantRoutes = Router();

tenantRoutes.use(requireAuth);
tenantRoutes.post('/', createTenant);
tenantRoutes.get('/', listMyTenants);

tenantRoutes.patch('/settings', requireTenant, requireRole('owner', 'admin'), updateTenantSettings);
tenantRoutes.get('/workflow', requireTenant, getWorkflow);

// Editing the workflow is owner/admin only.
const canEditWorkflow = [requireTenant, requireRole('owner', 'admin')];

tenantRoutes.post('/workflow/states', canEditWorkflow, createState);
// Must precede '/workflow/states/:id' or 'reorder' is captured as an id.
tenantRoutes.patch('/workflow/states/reorder', canEditWorkflow, reorderStates);
tenantRoutes.patch('/workflow/states/:id', canEditWorkflow, updateState);
tenantRoutes.delete('/workflow/states/:id', canEditWorkflow, deleteState);
