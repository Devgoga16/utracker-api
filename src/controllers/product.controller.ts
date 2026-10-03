import { Request, Response } from 'express';
import { Product } from '../models/Product';
import { ProductFilter } from '../models/ProductFilter';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

interface AttributeInput {
  filter: string;
  values: string[];
}

/**
 * Deja solo lo que existe de verdad: filtros de este negocio y valores que el
 * dueño declaró. Así el catálogo no termina con etiquetas inventadas por un
 * cliente malintencionado ni con restos de filtros ya borrados.
 */
async function sanitizeAttributes(
  raw: unknown,
  tenantId: string,
): Promise<AttributeInput[] | undefined> {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];

  const filters = await ProductFilter.find({ tenant: tenantId }).lean();
  const byId = new Map(filters.map((f) => [f._id.toString(), f]));

  const out: AttributeInput[] = [];
  for (const entry of raw) {
    const filterId = String((entry as AttributeInput)?.filter ?? '');
    const def = byId.get(filterId);
    if (!def) continue;

    const allowed = new Set(def.values);
    const values = Array.isArray((entry as AttributeInput).values)
      ? Array.from(new Set((entry as AttributeInput).values.map(String))).filter((v) =>
          allowed.has(v),
        )
      : [];

    // Un filtro sin valores elegidos no aporta nada: no se guarda.
    if (values.length) out.push({ filter: filterId, values });
  }
  return out;
}

export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const {
    kind, pricingMode, name, description, price, images, category, attributes, variants, stock, trackStock,
    requiresAdvance, advanceType, advanceValue, preparationDays,
  } = req.body;
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
    attributes: (await sanitizeAttributes(attributes, req.auth.tenantId)) ?? [],
    variants,
    preparationDays,
    requiresAdvance,
    advanceType,
    advanceValue,
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
  const {
    kind, pricingMode, name, description, price, images, category, attributes, variants, stock, trackStock,
    requiresAdvance, advanceType, advanceValue, preparationDays,
  } = req.body;
  const patch: Record<string, unknown> = {};
  if (kind !== undefined) patch.kind = kind;
  if (pricingMode !== undefined) patch.pricingMode = pricingMode;
  if (name !== undefined) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (price !== undefined) patch.price = price;
  if (images !== undefined) patch.images = images;
  if (category !== undefined) patch.category = category;
  if (attributes !== undefined) {
    patch.attributes = await sanitizeAttributes(attributes, req.auth.tenantId);
  }
  if (variants !== undefined) patch.variants = variants;
  if (preparationDays !== undefined) {
    patch.preparationDays = Math.max(0, Math.floor(Number(preparationDays) || 0));
  }
  if (requiresAdvance !== undefined) patch.requiresAdvance = requiresAdvance;
  if (advanceType !== undefined) patch.advanceType = advanceType;
  if (advanceValue !== undefined) patch.advanceValue = Math.max(0, Number(advanceValue) || 0);
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
