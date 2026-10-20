import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { requireWritable } from '../middleware/plan';
import {
  acceptInvitation,
  cancelInvitation,
  getPublicInvitation,
  getTeam,
  inviteMember,
  removeMember,
  updateMember,
} from '../controllers/team.controller';

export const teamRoutes = Router();

// El equipo lo maneja quien responde por el negocio.
teamRoutes.use(requireAuth, requireTenant, requireRole('owner', 'admin'));

teamRoutes.get('/', getTeam);

// Sumar gente es una escritura: con la suscripcion vencida no corresponde.
teamRoutes.post('/invitations', requireWritable, inviteMember);
teamRoutes.delete('/invitations/:id', cancelInvitation);
teamRoutes.patch('/members/:id', requireWritable, updateMember);
teamRoutes.delete('/members/:id', removeMember);

/**
 * Lo que abre el invitado. Publico y sin cabecera de negocio: el token de la
 * URL es la credencial, igual que en el seguimiento de un pedido.
 */
export const invitationRoutes = Router();

invitationRoutes.get('/:token', getPublicInvitation);
invitationRoutes.post('/:token/accept', acceptInvitation);
