import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { requireFeature } from '../middleware/plan';
import {
  deleteImageHandler,
  storageStatus,
  uploadImageHandler,
} from '../controllers/upload.controller';

// Memory storage: images are small and go straight back out to R2, so there is
// no reason to touch the disk. The limit is enforced here and again in the
// service, since the service is also reachable from other call sites.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.r2.maxUploadBytes, files: 1 },
});

export const uploadRoutes = Router();

uploadRoutes.use(requireAuth, requireTenant);

uploadRoutes.get('/status', storageStatus);
uploadRoutes.post('/', requireRole('owner', 'admin'), requireFeature('imageUploads'), upload.single('file'), uploadImageHandler);
uploadRoutes.delete('/', requireRole('owner', 'admin'), deleteImageHandler);
