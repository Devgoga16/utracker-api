import { Request, Response } from 'express';
import { ProductFilter } from '../models/ProductFilter';
import { Product } from '../models/Product';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/** Quita duplicados y vacíos conservando el orden en que los escribió el dueño. */
function cleanValues(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const value = String(v ?? '').trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

export const listProductFilters = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const filters = await ProductFilter.find({ tenant: req.auth.tenantId })
    .sort({ position: 1, name: 1 })
    .lean();
  res.json({ filters });
});

export const createProductFilter = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { name, values } = req.body as { name?: string; values?: string[] };

  if (!name?.trim()) throw ApiError.badRequest('El filtro necesita un nombre');

  const exists = await ProductFilter.findOne({ tenant: req.auth.tenantId, name: name.trim() });
  if (exists) throw ApiError.conflict('Ya tienes un filtro con ese nombre');

  const count = await ProductFilter.countDocuments({ tenant: req.auth.tenantId });

  const filter = await ProductFilter.create({
    tenant: req.auth.tenantId,
    name: name.trim(),
    values: cleanValues(values),
    position: count,
  });

  res.status(201).json({ filter });
});

export const updateProductFilter = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();
  const { name, values, position } = req.body as {
    name?: string;
    values?: string[];
    position?: number;
  };

  const filter = await ProductFilter.findOne({ _id: req.params.id, tenant: req.auth.tenantId });
  if (!filter) throw ApiError.notFound('Filtro no encontrado');

  if (name !== undefined) {
    if (!name.trim()) throw ApiError.badRequest('El filtro necesita un nombre');
    const clash = await ProductFilter.findOne({
      tenant: req.auth.tenantId,
      name: name.trim(),
      _id: { $ne: filter._id },
    });
    if (clash) throw ApiError.conflict('Ya tienes un filtro con ese nombre');
    filter.name = name.trim();
  }

  if (values !== undefined) {
    const next = cleanValues(values);

    /**
     * Un valor que se quita del filtro tiene que salir también de los
     * productos que lo tenían; si no, quedan etiquetados con algo que ya no
     * existe y el filtro público nunca los encontraría.
     */
    const removed = filter.values.filter((v) => !next.includes(v));
    if (removed.length) {
      await Product.updateMany(
        { tenant: req.auth.tenantId, 'attributes.filter': filter._id },
        { $pull: { 'attributes.$[attr].values': { $in: removed } } },
        { arrayFilters: [{ 'attr.filter': filter._id }] },
      );
    }

    filter.values = next;
  }

  if (position !== undefined) filter.position = position;

  await filter.save();
  res.json({ filter });
});

export const deleteProductFilter = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.unauthorized();

  const filter = await ProductFilter.findOneAndDelete({
    _id: req.params.id,
    tenant: req.auth.tenantId,
  });
  if (!filter) throw ApiError.notFound('Filtro no encontrado');

  // Sin esto los productos quedan apuntando a un filtro que ya no existe.
  await Product.updateMany(
    { tenant: req.auth.tenantId },
    { $pull: { attributes: { filter: filter._id } } },
  );

  res.status(204).send();
});
