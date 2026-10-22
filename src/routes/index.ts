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
import { planRoutes } from './plan.routes';
import { invitationRoutes, teamRoutes } from './team.routes';
import { showcaseRoutes } from './showcase.routes';
import { posRoutes } from './pos.routes';

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
// Punto de venta: ventas de mostrador y caja.
router.use('/pos', posRoutes);
router.use('/superadmin', superadminRoutes);
// Planes y catalogo de funcionalidades: publicos, los lee la pagina de precios.
router.use('/plans', planRoutes);
// Equipo del negocio, y lo que abre el invitado (publico, por token).
router.use('/team', teamRoutes);
router.use('/invitations', invitationRoutes);
// Socios que aceptaron aparecer en la web de uTracker (publico).
router.use('/showcase', showcaseRoutes);
router.use('/subscription', subscriptionRoutes);
router.use('/billing', billingRoutes);
router.use('/campaigns', campaignRoutes);
// API publica para webs externas; su propio CORS, abierto.
router.use('/storefront', storefrontRoutes);
router.use('/store-keys', storeKeyRoutes);
// Soporte: tickets del negocio y errores que reporta el navegador.
router.use('/tickets', ticketRoutes);
router.use('/logs', logRoutes);
