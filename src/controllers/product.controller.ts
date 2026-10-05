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

/**
 * Mantiene el filtro al día con las variantes del producto.
 *
 * Agrega al filtro los nombres que falten y devuelve el atributo que le
 * corresponde al producto. Así el dueño escribe "S, M, L" una sola vez en las
 * variantes y el filtro queda poblado y asignado solo.
 */
async function syncVariantFilter(
  tenantId: string,
  filterId: string,
  variants: { name?: string }[] | undefined,
): Promise<AttributeInput | null> {
  const names = Array.from(
    new Set((variants ?? []).map((v) => String(v?.name ?? '').trim()).filter(Boolean)),
  );
  if (!names.length) return null;

  const filter = await ProductFilter.findOne({ _id: filterId, tenant: tenantId });
  if (!filter) return null;

  const missing = names.filter(
    (n) => !filter.values.some((v) => v.toLowerCase() === n.toLowerCase()),
  );
  if (missing.length) {
    filter.values = [...filter.values, ...missing];
    await filter.save();
  }

  // Se usan los valores del filtro, para respetar su mayúscula/minúscula.
  const canonical = names.map(
    (n) => filter.values.find((v) => v.toLowerCase() === n.toLowerCase()) ?? n,
  );
  return { filter: filter._id.toString(), values: canonical };
}

/** Mezcla el atributo derivado de variantes con los elegidos a mano. */
function mergeAttributes(
  base: AttributeInput[] | undefined,
  derived: AttributeInput | null,
): AttributeInput[] | undefined {
  if (!derived) return base;
  const rest = (base ?? []).filter((a) => a.filter !== derived.filter);
  return [...rest, derived];
}

export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const {
    kind, pricingMode, name, description, price, images, category, attributes, variants, stock, trackStock,
    requiresAdvance, advanceType, advanceValue, preparationDays, lowStockThreshold, variantFilter,
  } = req.body;
  if (!name || price === undefined) throw ApiError.badRequest('name and price are required');

  const derived = variantFilter
    ? await syncVariantFilter(req.auth.tenantId, variantFilter, variants)
    : null;

  const product = await Product.create({
    tenant: req.auth.tenantId,
    kind,
    pricingMode,
    name,
    description,
    price,
    images,
    category,
    attributes:
      mergeAttributes(await sanitizeAttributes(attributes, req.auth.tenantId), derived) ?? [],
    variants,
    variantFilter: variantFilter || undefined,
    preparationDays,
    requiresAdvance,
    advanceType,
    advanceValue,
    stock,
    lowStockThreshold,
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
    requiresAdvance, advanceType, advanceValue, preparationDays, lowStockThreshold, variantFilter,
  } = req.body;
  const patch: Record<string, unknown> = {};
  if (kind !== undefined) patch.kind = kind;
  if (pricingMode !== undefined) patch.pricingMode = pricingMode;
  if (name !== undefined) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (price !== undefined) patch.price = price;
  if (images !== undefined) patch.images = images;
  if (category !== undefined) patch.category = category;
  if (variants !== undefined) patch.variants = variants;
  if (variantFilter !== undefined) patch.variantFilter = variantFilter || undefined;

  if (attributes !== undefined || variantFilter) {
    const derived = variantFilter
      ? await syncVariantFilter(req.auth.tenantId, variantFilter, variants)
      : null;
    patch.attributes = mergeAttributes(
      await sanitizeAttributes(attributes, req.auth.tenantId),
      derived,
    );
  }
  if (lowStockThreshold !== undefined) {
    patch.lowStockThreshold =
      lowStockThreshold === null || lowStockThreshold === ''
        ? undefined
        : Math.max(0, Math.floor(Number(lowStockThreshold) || 0));
  }
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
