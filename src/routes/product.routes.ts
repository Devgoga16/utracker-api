import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { checkLimit } from '../middleware/plan';
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
} from '../controllers/product.controller';

export const productRoutes = Router();

productRoutes.use(requireAuth, requireTenant);
productRoutes.get('/', listProducts);
productRoutes.get('/:id', getProduct);
productRoutes.post('/', requireRole('owner', 'admin'), checkLimit('catalog'), createProduct);
productRoutes.patch('/:id', requireRole('owner', 'admin'), updateProduct);
productRoutes.delete('/:id', requireRole('owner', 'admin'), deleteProduct);
