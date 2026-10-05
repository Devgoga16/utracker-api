import { Request, Response } from 'express';
import { StoreApiKey, generateStoreKey } from '../models/StoreApiKey';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

export const listStoreKeys = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const keys = await StoreApiKey.find({ tenant: req.auth.tenantId })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ keys });
});

export const createStoreKey = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { name, allowedOrigins } = req.body as { name?: string; allowedOrigins?: string[] };

  if (!name?.trim()) throw ApiError.badRequest('Ponle un nombre para reconocerla después');

  const key = await StoreApiKey.create({
    tenant: req.auth.tenantId,
    name: name.trim(),
    key: generateStoreKey(),
    allowedOrigins: (allowedOrigins ?? [])
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
  });

  res.status(201).json({ key });
});

export const updateStoreKey = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { name, allowedOrigins } = req.body as { name?: string; allowedOrigins?: string[] };

  const key = await StoreApiKey.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!key) throw ApiError.notFound('Llave no encontrada');

  if (name !== undefined) {
    if (!name.trim()) throw ApiError.badRequest('El nombre no puede quedar vacío');
    key.name = name.trim();
  }
  if (allowedOrigins !== undefined) {
    key.allowedOrigins = allowedOrigins.map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  }

  await key.save();
  res.json({ key });
});

/**
 * Revocar en vez de borrar: deja constancia de que existió y de cuándo se usó
 * por última vez, que es justamente lo que se quiere mirar tras un incidente.
 */
export const revokeStoreKey = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const key = await StoreApiKey.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!key) throw ApiError.notFound('Llave no encontrada');
  if (key.revokedAt) throw ApiError.conflict('Esta llave ya estaba revocada');

  key.revokedAt = new Date();
  await key.save();
  res.json({ key });
});

export const deleteStoreKey = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const key = await StoreApiKey.findOneAndDelete({
    _id: req.params.id,
    tenant: req.auth.tenantId,
  });
  if (!key) throw ApiError.notFound('Llave no encontrada');
  res.status(204).send();
});
