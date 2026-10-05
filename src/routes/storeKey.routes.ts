import { Router } from 'express';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import {
  listStoreKeys,
  createStoreKey,
  updateStoreKey,
  revokeStoreKey,
  deleteStoreKey,
} from '../controllers/storeApiKey.controller';

export const storeKeyRoutes = Router();

// Solo el dueno o un admin manejan las llaves de integracion.
storeKeyRoutes.use(requireAuth, requireTenant, requireRole('owner', 'admin'));

storeKeyRoutes.get('/', listStoreKeys);
storeKeyRoutes.post('/', createStoreKey);
storeKeyRoutes.patch('/:id', updateStoreKey);
storeKeyRoutes.post('/:id/revoke', revokeStoreKey);
storeKeyRoutes.delete('/:id', deleteStoreKey);
