import { Router } from 'express';
import { requireAuth, requireTenant } from '../middleware/auth';
import {
  closeMyTicket,
  createTicket,
  getMyTicket,
  listMyTickets,
  replyToMyTicket,
} from '../controllers/ticket.controller';
import { reportClientError } from '../controllers/support.controller';

export const ticketRoutes = Router();

// Los tickets son del negocio, no del usuario: cualquier miembro ve el hilo.
ticketRoutes.use(requireAuth, requireTenant);

ticketRoutes.get('/', listMyTickets);
ticketRoutes.post('/', createTicket);
ticketRoutes.get('/:id', getMyTicket);
ticketRoutes.post('/:id/messages', replyToMyTicket);
ticketRoutes.patch('/:id/close', closeMyTicket);

/**
 * Reporte de errores del navegador.
 *
 * Va aparte de los tickets porque no exige contexto de negocio: un render que
 * explota antes de elegir negocio igual tiene que llegar a los logs.
 */
export const logRoutes = Router();
logRoutes.post('/client', requireAuth, reportClientError);
