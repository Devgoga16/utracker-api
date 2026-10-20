import { Router } from 'express';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import { requireFeature } from '../middleware/plan';
import {
  listProductFilters,
  createProductFilter,
  updateProductFilter,
  deleteProductFilter,
} from '../controllers/productFilter.controller';

export const productFilterRoutes = Router();

productFilterRoutes.use(requireAuth, requireTenant);

productFilterRoutes.get('/', listProductFilters);
productFilterRoutes.post(
  '/',
  requireRole('owner', 'admin'),
  requireFeature('productFilters'),
  createProductFilter,
);
productFilterRoutes.patch(
  '/:id',
  requireRole('owner', 'admin'),
  requireFeature('productFilters'),
  updateProductFilter,
);
productFilterRoutes.delete('/:id', requireRole('owner', 'admin'), deleteProductFilter);
