import { Router } from 'express';
import { trackOrder } from '../controllers/tracking.controller';

// Public: this is the link the customer opens to follow their order.
export const trackingRoutes = Router();

trackingRoutes.get('/:token', trackOrder);
