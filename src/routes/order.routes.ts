import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { checkLimit, requireFeature, requireWritable } from '../middleware/plan';
import {
  addDeliveryAttempt,
  createOrder,
  deleteOrder,
  deletePayment,
  getOrder,
  listOrders,
  calendarOrders,
  cancelOrder,
  refundOrder,
  registerPayment,
  updateOrderState,
  validatePayment,
} from '../controllers/order.controller';
import { createOrderLink } from '../controllers/orderLink.controller';
import { todayOrders } from '../controllers/today.controller';

export const orderRoutes = Router();

orderRoutes.use(requireAuth, requireTenant);
/*
 * Roles, en corto: el repartidor mueve y cobra lo que entrega, pero no toma
 * pedidos ni los cancela. Eliminar borra el rastro: solo dueño y administrador.
 */
const team = requireRole('owner', 'admin', 'staff');
const managers = requireRole('owner', 'admin');

orderRoutes.post('/', team, checkLimit('maxOrdersPerMonth'), createOrder);
orderRoutes.get('/', listOrders);
// Antes de '/:id' o 'calendar' y 'today' se interpretarian como un id.
orderRoutes.get('/calendar', requireFeature('orderCalendar'), calendarOrders);
orderRoutes.get('/today', todayOrders);
orderRoutes.get('/:id', getOrder);
orderRoutes.delete('/:id', managers, deleteOrder);
orderRoutes.post('/:id/cancel', team, requireWritable, cancelOrder);
orderRoutes.post('/:id/refunds', team, requireWritable, refundOrder);
orderRoutes.patch('/:id/state', requireWritable, updateOrderState);
orderRoutes.post('/:id/payments', requireWritable, registerPayment);
orderRoutes.patch(
  '/:id/payments/:paymentId/validate',
  requireFeature('advancePayments'),
  validatePayment,
);
orderRoutes.delete('/:id/payments/:paymentId', deletePayment);
orderRoutes.post(
  '/:id/delivery-attempts',
  requireFeature('deliveryAttempts'),
  addDeliveryAttempt,
);
orderRoutes.post('/links', team, requireFeature('publicOrderLinks'), createOrderLink);
