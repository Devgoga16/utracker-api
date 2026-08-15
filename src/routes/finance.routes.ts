import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { requireFeature } from '../middleware/plan';
import { getFinanceSummary, getFinanceOrders } from '../controllers/finance.controller';

export const financeRoutes = Router();

const guard = [requireAuth, requireTenant, requireRole('owner', 'admin'), requireFeature('finances')];

financeRoutes.get('/summary', guard, getFinanceSummary);
financeRoutes.get('/orders', guard, getFinanceOrders);
