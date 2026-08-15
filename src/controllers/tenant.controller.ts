import { Request, Response } from 'express';
import { Tenant } from '../models/Tenant';
import { Membership } from '../models/Membership';
import { WorkflowState } from '../models/WorkflowState';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { seedDefaultWorkflow } from '../services/workflowDefaults';
import { deleteByUrl } from '../services/storage';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export const createTenant = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw ApiError.unauthorized();
  const { name } = req.body as { name: string };
  if (!name) throw ApiError.badRequest('name is required');

  const baseSlug = slugify(name);
  let slug = baseSlug;
  let suffix = 1;
  while (await Tenant.exists({ slug })) {
    slug = `${baseSlug}-${suffix++}`;
  }

  const tenant = await Tenant.create({ name, slug });
  await Membership.create({ tenant: tenant._id, user: req.auth.userId, role: 'owner' });
  await seedDefaultWorkflow(tenant._id);

  res.status(201).json({ tenant });
});

export const listMyTenants = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw ApiError.unauthorized();
  const memberships = await Membership.find({ user: req.auth.userId, isActive: true }).populate('tenant').lean();
  res.json({ tenants: memberships.map((m) => ({ ...(m.tenant as unknown as Record<string, unknown>), role: m.role })) });
});

export const updateTenantSettings = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { name, logoUrl, phone } = req.body as {
    name?: string;
    logoUrl?: string | null;
    phone?: string | null;
  };

  const tenant = await Tenant.findById(req.auth.tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');

  if (name !== undefined) {
    if (!name.trim()) throw ApiError.badRequest('name cannot be empty');
    tenant.name = name.trim();
  }

  if (phone !== undefined) {
    // Guardamos solo digitos: wa.me no acepta espacios ni signos.
    const digits = phone?.replace(/\D/g, '') ?? '';
    if (digits && (digits.length < 8 || digits.length > 15)) {
      throw ApiError.badRequest('phone must have between 8 and 15 digits');
    }
    tenant.phone = digits || undefined;
  }

  if (logoUrl !== undefined) {
    // If replacing an existing logo, clean up the old one from R2.
    if (tenant.logoUrl && tenant.logoUrl !== logoUrl) {
      await deleteByUrl(tenant.logoUrl);
    }
    tenant.logoUrl = logoUrl ?? undefined;
  }

  await tenant.save();
  res.json({ tenant });
});

export const getWorkflow = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const states = await WorkflowState.find({ tenant: req.auth.tenantId }).sort({ kind: 1, position: 1 });
  res.json({
    fulfillment: states.filter((s) => s.kind === 'fulfillment'),
    payment: states.filter((s) => s.kind === 'payment'),
  });
});
