import { Router } from 'express';
import { getFeatureCatalog, listPublicPlans } from '../controllers/plan.controller';

/**
 * Planes y catálogo, públicos y sin auth.
 *
 * La página de precios y el registro los leen de aquí, para que cambiar un plan
 * sea editar un documento y no desplegar el front.
 */
export const planRoutes = Router();

// Antes de cualquier ruta con parámetro, aunque hoy no haya ninguna.
planRoutes.get('/features', getFeatureCatalog);
planRoutes.get('/', listPublicPlans);
