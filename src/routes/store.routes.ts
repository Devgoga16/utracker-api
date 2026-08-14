import { Router } from 'express';
import { getStoreCatalog } from '../controllers/store.controller';

export const storeRoutes = Router();

storeRoutes.get('/:slug', getStoreCatalog);
