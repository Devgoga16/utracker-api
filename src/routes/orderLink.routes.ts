import { Router } from 'express';
import { confirmPublicOrderLink, getPublicOrderLink } from '../controllers/orderLink.controller';

// Public routes, no auth: this is what the customer opens from the WhatsApp/email link.
export const orderLinkRoutes = Router();

orderLinkRoutes.get('/:token', getPublicOrderLink);
orderLinkRoutes.post('/:token/confirm', confirmPublicOrderLink);
