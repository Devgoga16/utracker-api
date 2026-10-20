import { Router } from 'express';
import { requireAuth, requireTenant } from '../middleware/auth';
import { checkLimit, requireFeature, requireWritable } from '../middleware/plan';
import {
  addDeliveryAttempt,
  createOrder,
  deleteOrder,
  deletePayment,
  getOrder,
  listOrders,
  calendarOrders,
  registerPayment,
  updateOrderState,
  validatePayment,
} from '../controllers/order.controller';
import { createOrderLink } from '../controllers/orderLink.controller';

export const orderRoutes = Router();

orderRoutes.use(requireAuth, requireTenant);
orderRoutes.post('/', checkLimit('maxOrdersPerMonth'), createOrder);
orderRoutes.get('/', listOrders);
// Antes de '/:id' o 'calendar' se interpretaria como un id.
orderRoutes.get('/calendar', requireFeature('orderCalendar'), calendarOrders);
orderRoutes.get('/:id', getOrder);
orderRoutes.delete('/:id', deleteOrder);
orderRoutes.patch('/:id/state', requireWritable, updateOrderState);
orderRoutes.post('/:id/payments', requireWritable, registerPayment);
orderRoutes.patch(
  '/:id/payments/:kind/validate',
  requireFeature('advancePayments'),
  validatePayment,
);
orderRoutes.delete('/:id/payments/:kind', deletePayment);
orderRoutes.post(
  '/:id/delivery-attempts',
  requireFeature('deliveryAttempts'),
  addDeliveryAttempt,
);
orderRoutes.post('/links', requireFeature('publicOrderLinks'), createOrderLink);
