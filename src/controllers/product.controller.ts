import { Request, Response } from 'express';
import { Product } from '../models/Product';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { kind, pricingMode, name, description, price, images, category, variants, stock, trackStock } =
    req.body;
  if (!name || price === undefined) throw ApiError.badRequest('name and price are required');

  const product = await Product.create({
    tenant: req.auth.tenantId,
    kind,
    pricingMode,
    name,
    description,
    price,
    images,
    category,
    variants,
    stock,
    // Services have nothing to count.
    trackStock: kind === 'service' ? false : trackStock,
  });

  res.status(201).json({ product });
});

export const listProducts = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const products = await Product.find({ tenant: req.auth.tenantId, isActive: true }).sort({ createdAt: -1 });
  res.json({ products });
});

export const getProduct = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const product = await Product.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!product) throw ApiError.notFound('Product not found');
  res.json({ product });
});

export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { kind, pricingMode, name, description, price, images, category, variants, stock, trackStock } =
    req.body;
  const patch: Record<string, unknown> = {};
  if (kind !== undefined) patch.kind = kind;
  if (pricingMode !== undefined) patch.pricingMode = pricingMode;
  if (name !== undefined) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (price !== undefined) patch.price = price;
  if (images !== undefined) patch.images = images;
  if (category !== undefined) patch.category = category;
  if (variants !== undefined) patch.variants = variants;
  if (stock !== undefined) patch.stock = stock;
  if (trackStock !== undefined) patch.trackStock = kind === 'service' ? false : trackStock;
  if (kind === 'service') patch.trackStock = false;

  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, tenant: req.auth.tenantId },
    { $set: patch },
    { new: true, runValidators: true }
  );
  if (!product) throw ApiError.notFound('Product not found');
  res.json({ product });
});

export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, tenant: req.auth.tenantId },
    { $set: { isActive: false } },
    { new: true }
  );
  if (!product) throw ApiError.notFound('Product not found');
  res.status(204).send();
});
