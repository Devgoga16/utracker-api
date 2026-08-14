import { Router } from 'express';
import { authRoutes } from './auth.routes';
import { tenantRoutes } from './tenant.routes';
import { productRoutes } from './product.routes';
import { orderRoutes } from './order.routes';
import { orderLinkRoutes } from './orderLink.routes';
import { trackingRoutes } from './tracking.routes';
import { uploadRoutes } from './upload.routes';
import { storeRoutes } from './store.routes';
import { categoryRoutes } from './category.routes';

export const router = Router();

router.use('/auth', authRoutes);
router.use('/tenants', tenantRoutes);
router.use('/products', productRoutes);
router.use('/orders', orderRoutes);
router.use('/order-links', orderLinkRoutes);
router.use('/track', trackingRoutes);
router.use('/uploads', uploadRoutes);
router.use('/store', storeRoutes);
router.use('/categories', categoryRoutes);
