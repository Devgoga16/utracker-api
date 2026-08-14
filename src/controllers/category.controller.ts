import { Request, Response } from 'express';
import { Category } from '../models/Category';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

export const listCategories = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const categories = await Category.find({ tenant: req.auth.tenantId }).sort({ name: 1 });
  res.json({ categories });
});

export const createCategory = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { name } = req.body as { name: string };
  if (!name?.trim()) throw ApiError.badRequest('name is required');

  const existing = await Category.findOne({ tenant: req.auth.tenantId, name: name.trim() });
  if (existing) throw ApiError.conflict('Ya existe una categoría con ese nombre');

  const category = await Category.create({ tenant: req.auth.tenantId, name: name.trim() });
  res.status(201).json({ category });
});

export const deleteCategory = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const category = await Category.findOneAndDelete({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!category) throw ApiError.notFound('Category not found');
  res.status(204).send();
});
