import { Router } from 'express';
import { listShowcase } from '../controllers/showcase.controller';

// Público: la sección de socios del landing.
export const showcaseRoutes = Router();

showcaseRoutes.get('/', listShowcase);
