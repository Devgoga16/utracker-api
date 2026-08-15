import multer from 'multer';
import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { env } from '../config/env';
import {
  getMyBills,
  uploadProofFile,
  submitProof,
} from '../controllers/billing.controller';

// Same multer setup as uploads — memory only, limit enforced in service too.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.r2.maxUploadBytes, files: 1 },
});

export const billingRoutes = Router();

billingRoutes.use(requireAuth, requireTenant);

// No requireFeature gate: billing proof upload must always be available.
billingRoutes.post('/upload', upload.single('file'), uploadProofFile);
billingRoutes.get('/me', getMyBills);
billingRoutes.patch('/:id/proof', requireRole('owner'), submitProof);
