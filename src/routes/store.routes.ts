import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import {
  getStoreCatalog,
  createStoreOrder,
  uploadStoreProof,
} from '../controllers/store.controller';

// Mismo multer que el resto: en memoria, con el límite también en el servicio.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.r2.maxUploadBytes, files: 1 },
});

export const storeRoutes = Router();

// Públicas: sin auth ni tenant header, el slug identifica la tienda.
storeRoutes.get('/:slug', getStoreCatalog);
storeRoutes.post('/:slug/proof', upload.single('file'), uploadStoreProof);
storeRoutes.post('/:slug/order', createStoreOrder);
