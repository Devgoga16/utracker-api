import { Router } from 'express';
import { requireAuth, requireTenant } from '../middleware/auth';
import { checkLimit, requireFeature } from '../middleware/plan';
import {
  addDeliveryAttempt,
  createOrder,
  deleteOrder,
  deletePayment,
  getOrder,
  listOrders,
  registerPayment,
  updateOrderState,
} from '../controllers/order.controller';
import { createOrderLink } from '../controllers/orderLink.controller';

export const orderRoutes = Router();

orderRoutes.use(requireAuth, requireTenant);
orderRoutes.post('/', checkLimit('orders'), createOrder);
orderRoutes.get('/', listOrders);
orderRoutes.get('/:id', getOrder);
orderRoutes.delete('/:id', deleteOrder);
orderRoutes.patch('/:id/state', updateOrderState);
orderRoutes.post('/:id/payments', registerPayment);
orderRoutes.delete('/:id/payments/:kind', deletePayment);
orderRoutes.post('/:id/delivery-attempts', addDeliveryAttempt);
orderRoutes.post('/links', requireFeature('publicOrderLinks'), createOrderLink);
