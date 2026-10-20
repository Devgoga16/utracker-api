import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { Plan, PLAN_CODE_PATTERN, planCodeFromName } from '../models/Plan';
import { Subscription } from '../models/Subscription';
import {
  FeatureMap,
  coerceFeatureValue,
  featureCatalogPayload,
  isFeatureKey,
} from '../config/features.catalog';
import { invalidateAllEntitlements } from '../services/entitlements';

/**
 * Convierte lo que llegó por HTTP en un mapa de funcionalidades válido.
 *
 * Rechaza las claves que no están en el catálogo en vez de ignorarlas: un
 * `features: { inventorio: true }` mal escrito guardado en silencio es un plan
 * que promete algo y no lo cumple, y nadie se enteraría hasta el reclamo.
 *
 * Con `allowNull` un `null` significa "quitar esta clave", que es lo que hace
 * falta para borrar una excepción de un negocio.
 */
export function parseFeatureMap(
  raw: unknown,
  { allowNull = false }: { allowNull?: boolean } = {},
): FeatureMap {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw ApiError.badRequest('features debe ser un objeto de clave → valor');
  }

  const out: FeatureMap = {};
  const unknown: string[] = [];
  const invalid: string[] = [];

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFeatureKey(key)) {
      unknown.push(key);
      continue;
    }

    if (value === null) {
      if (!allowNull) {
        invalid.push(key);
        continue;
      }
      // null sobrevive para que el llamador sepa que hay que quitarla.
      out[key] = null as never;
      continue;
    }

    const coerced = coerceFeatureValue(key, value);
    if (coerced === null) {
      invalid.push(key);
      continue;
    }
    out[key] = coerced;
  }

  if (unknown.length) {
    throw ApiError.badRequest(
      `Estas funcionalidades no existen en el catálogo: ${unknown.join(', ')}`,
    );
  }
  if (invalid.length) {
    throw ApiError.badRequest(
      `Valor inválido para: ${invalid.join(', ')}. Los flags son true/false y los límites enteros ≥ 0.`,
    );
  }

  return out;
}

/* ════════════════════ Público ════════════════════ */

// GET /plans — lo que se muestra en la página de precios.
export const listPublicPlans = asyncHandler(async (_req: Request, res: Response) => {
  const plans = await Plan.find({ isPublic: true, isActive: true })
    .sort({ sortOrder: 1, price: 1 })
    .select('-__v')
    .lean();
  res.json(plans);
});

// GET /plans/features — el catálogo con sus etiquetas.
export const getFeatureCatalog = asyncHandler(async (_req: Request, res: Response) => {
  res.json(featureCatalogPayload());
});

/* ════════════════════ Superadmin ════════════════════ */

// GET /superadmin/plans
export const listPlans = asyncHandler(async (_req: Request, res: Response) => {
  const plans = await Plan.find().sort({ sortOrder: 1, price: 1 }).lean();

  // Cuántos negocios tiene cada plan: sin esto, desactivar un plan es a ciegas.
  const counts = await Subscription.aggregate<{ _id: unknown; count: number }>([
    { $group: { _id: '$plan', count: { $sum: 1 } } },
  ]);
  const byPlan = new Map(counts.map((c) => [String(c._id), c.count]));

  res.json(plans.map((p) => ({ ...p, tenantCount: byPlan.get(String(p._id)) ?? 0 })));
});

// POST /superadmin/plans
export const createPlan = asyncHandler(async (req: Request, res: Response) => {
  const { code, name, description, price, priceYearly, features, isPublic, isActive, sortOrder } =
    req.body as Record<string, unknown>;

  if (typeof name !== 'string' || !name.trim()) throw ApiError.badRequest('El nombre es obligatorio');

  const wanted = typeof code === 'string' && code.trim() ? code.trim().toLowerCase() : planCodeFromName(name);
  if (!PLAN_CODE_PATTERN.test(wanted)) {
    throw ApiError.badRequest(
      'El código va en minúsculas, de 2 a 40 caracteres, con letras, números, guion o guion bajo.',
    );
  }
  if (await Plan.exists({ code: wanted })) {
    throw ApiError.conflict(`Ya existe un plan con el código "${wanted}"`);
  }

  const plan = await Plan.create({
    code: wanted,
    name: name.trim(),
    description: typeof description === 'string' ? description.trim() : undefined,
    price: Number(price) || 0,
    priceYearly: priceYearly === undefined || priceYearly === null ? undefined : Number(priceYearly),
    features: parseFeatureMap(features),
    isPublic: isPublic === undefined ? true : Boolean(isPublic),
    isActive: isActive === undefined ? true : Boolean(isActive),
    sortOrder: Number(sortOrder) || 0,
  });

  res.status(201).json(plan);
});

// PUT /superadmin/plans/:id
export const updatePlan = asyncHandler(async (req: Request, res: Response) => {
  const plan = await Plan.findById(req.params.id);
  if (!plan) throw ApiError.notFound('Plan no encontrado');

  const { name, description, price, priceYearly, features, isPublic, isActive, sortOrder } =
    req.body as Record<string, unknown>;

  // El código no se edita: es lo que referencian los enlaces y los acuerdos.
  if (typeof name === 'string' && name.trim()) plan.name = name.trim();
  if (description !== undefined) {
    plan.description = typeof description === 'string' ? description.trim() : undefined;
  }
  if (price !== undefined) plan.price = Number(price) || 0;
  if (priceYearly !== undefined) {
    plan.priceYearly = priceYearly === null ? undefined : Number(priceYearly) || 0;
  }
  if (isPublic !== undefined) plan.isPublic = Boolean(isPublic);
  if (isActive !== undefined) plan.isActive = Boolean(isActive);
  if (sortOrder !== undefined) plan.sortOrder = Number(sortOrder) || 0;

  /**
   * Las funcionalidades se mezclan clave por clave: lo que no se manda queda
   * como estaba. Así el formulario puede guardar solo lo que tocó, y una clave
   * nueva del catálogo no borra el resto del plan.
   */
  if (features !== undefined) {
    const patch = parseFeatureMap(features);
    plan.features = { ...(plan.features ?? {}), ...patch };
    plan.markModified('features');
  }

  await plan.save();

  // Editar un plan afecta ya a todos los negocios que lo tienen.
  invalidateAllEntitlements();

  res.json(plan);
});

// DELETE /superadmin/plans/:id
export const deletePlan = asyncHandler(async (req: Request, res: Response) => {
  const plan = await Plan.findById(req.params.id);
  if (!plan) throw ApiError.notFound('Plan no encontrado');

  const inUse = await Subscription.countDocuments({ plan: plan._id });

  /**
   * Un plan en uso no se borra, se retira: queda inactivo y no público.
   *
   * Borrarlo dejaría a esos negocios con una suscripción que apunta a la nada,
   * y el resolvedor de permisos los trataría como si no tuvieran plan.
   */
  if (inUse > 0) {
    plan.isActive = false;
    plan.isPublic = false;
    await plan.save();
    invalidateAllEntitlements();
    return res.json({
      retired: true,
      tenantCount: inUse,
      message: `El plan quedó retirado: lo usan ${inUse} negocio(s), así que no se puede borrar.`,
    });
  }

  await plan.deleteOne();
  invalidateAllEntitlements();
  res.json({ retired: false, deleted: true });
});
