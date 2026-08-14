import { Router } from 'express';
import { requireAuth, requireTenant } from '../middleware/auth';
import { listCategories, createCategory, deleteCategory } from '../controllers/category.controller';

export const categoryRoutes = Router();

categoryRoutes.use(requireAuth, requireTenant);
categoryRoutes.get('/', listCategories);
categoryRoutes.post('/', createCategory);
categoryRoutes.delete('/:id', deleteCategory);
