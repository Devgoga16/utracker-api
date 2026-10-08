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
import { productFilterRoutes } from './productFilter.routes';
import { inventoryRoutes } from './inventory.routes';
import { financeRoutes } from './finance.routes';
import { superadminRoutes } from './superadmin.routes';
import { subscriptionRoutes } from './subscription.routes';
import { billingRoutes } from './billing.routes';
import { campaignRoutes } from './campaign.routes';
import { storefrontRoutes } from './storefront.routes';
import { storeKeyRoutes } from './storeKey.routes';
import { logRoutes, ticketRoutes } from './ticket.routes';

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
router.use('/product-filters', productFilterRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/finance', financeRoutes);
router.use('/superadmin', superadminRoutes);
router.use('/subscription', subscriptionRoutes);
router.use('/billing', billingRoutes);
router.use('/campaigns', campaignRoutes);
// API publica para webs externas; su propio CORS, abierto.
router.use('/storefront', storefrontRoutes);
router.use('/store-keys', storeKeyRoutes);
// Soporte: tickets del negocio y errores que reporta el navegador.
router.use('/tickets', ticketRoutes);
router.use('/logs', logRoutes);
