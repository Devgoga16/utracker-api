import { Router } from 'express';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getPublicCampaign,
  confirmCampaignOrder,
} from '../controllers/campaign.controller';

export const campaignRoutes = Router();

// ─── Owner routes (authenticated) ────────────────────────────────────────────
campaignRoutes.get('/', requireAuth, requireTenant, listCampaigns);
campaignRoutes.get('/:id', requireAuth, requireTenant, getCampaign);
campaignRoutes.post('/', requireAuth, requireTenant, requireRole('owner', 'admin'), createCampaign);
campaignRoutes.patch('/:id', requireAuth, requireTenant, requireRole('owner', 'admin'), updateCampaign);
campaignRoutes.delete('/:id', requireAuth, requireTenant, requireRole('owner', 'admin'), deleteCampaign);

// ─── Public routes ────────────────────────────────────────────────────────────
campaignRoutes.get('/public/:token', getPublicCampaign);
campaignRoutes.post('/public/:token/order', confirmCampaignOrder);
