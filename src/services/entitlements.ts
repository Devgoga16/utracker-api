import { Types } from 'mongoose';
import {
  FEATURE_KEYS,
  FeatureKey,
  FeatureValue,
  FeatureMap,
  ResolvedFeatures,
  defaultFeatureValue,
} from '../config/features.catalog';
import { IPlan } from '../models/Plan';
import { Subscription, EffectiveStatus } from '../models/Subscription';

export interface Entitlements {
  features: ResolvedFeatures;
  /** El estado con el que se decide, ya considerando la fecha de vencimiento. */
  status: EffectiveStatus;
  /** Puede mirar todo pero no registrar nada. */
  readOnly: boolean;
  plan: { _id: string; code?: string; name: string; price: number } | null;
  /** Qué claves vienen de una excepción del negocio y no del plan. */
  overridden: FeatureKey[];
  expiresAt: Date | null;
}

/**
 * Cuánto vive una resolución en memoria.
 *
 * Cada request con bloqueo consulta esto, así que sin caché serían dos
 * consultas extra por pedido creado. Un minuto es poco para que un cambio de
 * plan se sienta "no se aplicó" y suficiente para que no pese.
 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: Entitlements;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Se llama al tocar una suscripción. */
export function invalidateEntitlements(tenantId: string | Types.ObjectId) {
  cache.delete(String(tenantId));
}

/**
 * Se llama al tocar un plan: no se sabe a qué negocios afecta sin consultar,
 * y editar un plan es raro mientras que resolver permisos es constante.
 */
export function invalidateAllEntitlements() {
  cache.clear();
}

/**
 * El estado real, que puede no ser el guardado.
 *
 * Una suscripción marcada 'active' con la fecha pasada está vencida, y hacer
 * que mande la fecha evita depender de un cron que no existe.
 */
export function effectiveStatus(
  status: EffectiveStatus,
  expiresAt?: Date | null,
): EffectiveStatus {
  if (status === 'suspended') return 'suspended';
  if (expiresAt && expiresAt.getTime() < Date.now()) return 'expired';
  return status;
}

/** Excepción del negocio → valor del plan → valor por defecto del catálogo. */
function resolveFeatures(
  planFeatures: FeatureMap | undefined,
  overrides: FeatureMap | undefined,
): { features: ResolvedFeatures; overridden: FeatureKey[] } {
  const features = {} as ResolvedFeatures;
  const overridden: FeatureKey[] = [];

  for (const key of FEATURE_KEYS) {
    const override = overrides?.[key];
    if (override !== undefined && override !== null) {
      features[key] = override as FeatureValue;
      overridden.push(key);
      continue;
    }

    const fromPlan = planFeatures?.[key];
    features[key] =
      fromPlan !== undefined && fromPlan !== null
        ? (fromPlan as FeatureValue)
        : defaultFeatureValue(key);
  }

  return { features, overridden };
}

/**
 * Qué puede hacer este negocio.
 *
 * Un negocio sin suscripción queda con todo habilitado y sin límites. Es
 * deliberado: uTracker ya tiene negocios andando de antes de que existieran los
 * planes, y bloquearlos por un documento que nunca se les creó sería romperles
 * la operación para arreglar un tema administrativo.
 */
export async function getEntitlements(tenantId: string): Promise<Entitlements> {
  const key = String(tenantId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const sub = await Subscription.findOne({ tenant: tenantId })
    .populate<{ plan: IPlan }>('plan')
    .lean();

  let value: Entitlements;

  if (!sub) {
    const features = {} as ResolvedFeatures;
    for (const k of FEATURE_KEYS) features[k] = FEATURES_ALL_ON[k];
    value = {
      features,
      status: 'active',
      readOnly: false,
      plan: null,
      overridden: [],
      expiresAt: null,
    };
  } else {
    const plan = sub.plan as IPlan | null;
    const { features, overridden } = resolveFeatures(plan?.features, sub.overrides);
    const status = effectiveStatus(sub.status, sub.expiresAt ?? null);

    value = {
      features,
      status,
      readOnly: status === 'suspended' || status === 'expired',
      plan: plan
        ? { _id: String(plan._id), code: plan.code, name: plan.name, price: plan.price }
        : null,
      overridden,
      expiresAt: sub.expiresAt ?? null,
    };
  }

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Todo encendido y sin límites: lo que ve un negocio sin suscripción. */
const FEATURES_ALL_ON: ResolvedFeatures = FEATURE_KEYS.reduce((acc, key) => {
  acc[key] = typeof defaultFeatureValue(key) === 'boolean' ? true : 0;
  return acc;
}, {} as ResolvedFeatures);

export function hasFeature(ent: Entitlements, key: FeatureKey): boolean {
  return Boolean(ent.features[key]);
}

/** El tope de una clave de límite. 0 = ilimitado. */
export function limitOf(ent: Entitlements, key: FeatureKey): number {
  const value = ent.features[key];
  return typeof value === 'number' ? value : 0;
}
