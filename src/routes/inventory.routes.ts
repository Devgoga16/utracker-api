import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { listInventory, adjustStock, listMovements } from '../controllers/inventory.controller';

export const inventoryRoutes = Router();

const guard = [requireAuth, requireTenant];
const ownerGuard = [...guard, requireRole('owner', 'admin')];

inventoryRoutes.get('/', guard, listInventory);
inventoryRoutes.patch('/:id/adjust', ownerGuard, adjustStock);
inventoryRoutes.get('/:id/movements', guard, listMovements);
