import { Router } from 'express';
import cors from 'cors';
import multer from 'multer';
import { env } from '../config/env';
import { requireStoreKey } from '../middleware/storeKey';
import {
  storefrontConfig,
  storefrontProducts,
  storefrontCampaigns,
  createCheckoutSession,
  getCheckoutSession,
  uploadCheckoutProof,
  confirmCheckoutSession,
} from '../controllers/storefront.controller';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.r2.maxUploadBytes, files: 1 },
});

export const storefrontRoutes = Router();

/**
 * CORS abierto a proposito, solo en este router.
 *
 * El sentido de la API es que la consuma cualquier web, asi que no se puede
 * exigir una lista de origenes como en el panel. Lo que protege no es el
 * origen sino la llave: habilita unicamente datos ya publicos y crear una
 * sesion de compra, y el dueno puede limitarle dominios desde el panel.
 */
storefrontRoutes.use(cors({ origin: true, credentials: false }));

// ─── Con llave: lo que consume la web del tercero ──────────────────────
storefrontRoutes.get('/config', requireStoreKey, storefrontConfig);
storefrontRoutes.get('/products', requireStoreKey, storefrontProducts);
storefrontRoutes.get('/campaigns', requireStoreKey, storefrontCampaigns);
storefrontRoutes.post('/checkout', requireStoreKey, createCheckoutSession);

// ─── Sin llave: lo abre el navegador del comprador ─────────────────────
// El token de la sesión es la credencial, como el de seguimiento.
storefrontRoutes.get('/checkout/:token', getCheckoutSession);
storefrontRoutes.post('/checkout/:token/proof', upload.single('file'), uploadCheckoutProof);
storefrontRoutes.post('/checkout/:token/confirm', confirmCheckoutSession);
