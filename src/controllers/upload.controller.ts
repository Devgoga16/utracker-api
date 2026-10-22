import { Request, Response } from 'express';
import { isStorageConfigured } from '../config/env';
import { deleteByUrl, uploadImage } from '../services/storage';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * - catalog: fotos de productos y el logo. Solo dueño y administrador, que son
 *   quienes editan el catálogo y los ajustes.
 * - payments: fotos de comprobantes. Cualquiera del equipo: quien cobra suele
 *   ser el personal, y sin la foto no queda respaldo del pago.
 */
const ALLOWED_FOLDERS = ['catalog', 'payments'] as const;
type Folder = (typeof ALLOWED_FOLDERS)[number];

const CATALOG_ROLES = ['owner', 'admin'];

function assertCanUse(req: Request, folder: Folder) {
  if (folder === 'catalog' && !CATALOG_ROLES.includes(req.auth?.role ?? '')) {
    throw ApiError.forbidden('Solo el dueño o un administrador pueden subir fotos del catálogo');
  }
}

function parseFolder(value: unknown): Folder {
  if (typeof value === 'string' && ALLOWED_FOLDERS.includes(value as Folder)) {
    return value as Folder;
  }
  return 'catalog';
}

export const uploadImageHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  if (!req.file) throw ApiError.badRequest('No se recibió ningún archivo (campo "file")');

  const folder = parseFolder(req.body.folder);
  assertCanUse(req, folder);
  const uploaded = await uploadImage(req.file.buffer, req.auth.tenantId, folder);
  res.status(201).json(uploaded);
});

export const deleteImageHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const { url } = req.body as { url?: string };
  if (!url) throw ApiError.badRequest('Falta la url');

  // Anyone could pass any URL, so refuse keys outside this tenant's prefix.
  if (!url.includes(`/${req.auth.tenantId}/`)) {
    throw ApiError.forbidden('Esa imagen no pertenece a este negocio');
  }
  assertCanUse(req, url.includes(`/${req.auth.tenantId}/payments/`) ? 'payments' : 'catalog');

  await deleteByUrl(url);
  res.status(204).send();
});

export const storageStatus = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ configured: isStorageConfigured() });
});
