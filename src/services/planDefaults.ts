import { Plan } from '../models/Plan';
import { FEATURE_KEYS, FeatureMap, defaultFeatureValue } from '../config/features.catalog';

/**
 * Los tres planes con los que arranca una instalación nueva.
 *
 * Se insertan con `$setOnInsert`: si el código ya existe no se toca nada. Por
 * eso editar este archivo no cambia una base que ya los tiene — para eso está
 * la pantalla de planes, que es justamente el punto de todo esto.
 */
interface PlanSeed {
  code: string;
  name: string;
  description: string;
  price: number;
  priceYearly: number;
  sortOrder: number;
  features: FeatureMap;
}

const SEEDS: PlanSeed[] = [
  {
    code: 'emprende',
    name: 'Emprende',
    description: 'Para empezar a ordenar los pedidos y dejar el cuaderno.',
    price: 39,
    // Diez meses: dos de regalo por pagar el año.
    priceYearly: 390,
    sortOrder: 1,
    features: {
      maxOrdersPerMonth: 100,
      maxCatalogItems: 30,
      maxWorkflowStates: 8,
      maxMembers: 2,
      maxCampaigns: 0,
      maxStoreKeys: 0,

      orderCalendar: true,
      imageUploads: true,
      publicTracking: true,
      receipts: true,
    },
  },
  {
    code: 'negocio',
    name: 'Negocio',
    description: 'Para vender online, cobrar adelantos y controlar el stock.',
    price: 79,
    priceYearly: 790,
    sortOrder: 2,
    features: {
      maxOrdersPerMonth: 500,
      maxCatalogItems: 200,
      maxWorkflowStates: 20,
      maxMembers: 5,
      maxCampaigns: 3,
      maxStoreKeys: 0,

      workflowCustomization: true,
      orderCalendar: true,
      deliveryTypes: true,
      deliveryAttempts: true,
      pos: true,
      advancePayments: true,
      receipts: true,
      finances: true,
      imageUploads: true,
      productFilters: true,
      inventory: true,
      publicTracking: true,
      publicOrderLinks: true,
      publicStore: true,
      campaigns: true,
      whatsappNotifications: true,
      branding: true,
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Sin límites, con API de tienda para tu propia web y soporte prioritario.',
    price: 149,
    priceYearly: 1490,
    sortOrder: 3,
    features: {
      // 0 = ilimitado en todos los límites.
      maxOrdersPerMonth: 0,
      maxCatalogItems: 0,
      maxWorkflowStates: 0,
      maxMembers: 0,
      maxCampaigns: 0,
      maxStoreKeys: 5,

      workflowCustomization: true,
      orderCalendar: true,
      deliveryTypes: true,
      deliveryAttempts: true,
      pos: true,
      advancePayments: true,
      receipts: true,
      finances: true,
      imageUploads: true,
      productFilters: true,
      inventory: true,
      publicTracking: true,
      publicOrderLinks: true,
      publicStore: true,
      campaigns: true,
      storefrontApi: true,
      whatsappNotifications: true,
      branding: true,
      prioritySupport: true,
    },
  },
];

/**
 * Cada funcionalidad del catálogo escrita: las del plan con su valor, el resto
 * apagadas. Así «no está» nunca significa nada: un plan dice lo que incluye
 * y lo que no.
 */
function complete(features: FeatureMap): FeatureMap {
  const out: FeatureMap = {};
  for (const key of FEATURE_KEYS) out[key] = features[key] ?? defaultFeatureValue(key);
  return out;
}

/** Crea los planes que falten. No modifica ninguno que ya exista. */
export async function seedDefaultPlans(): Promise<number> {
  let created = 0;

  for (const seed of SEEDS) {
    const result = await Plan.updateOne(
      { code: seed.code },
      { $setOnInsert: { ...seed, features: complete(seed.features), isPublic: true, isActive: true } },
      { upsert: true },
    );
    if (result.upsertedCount) created += 1;
  }

  if (created) console.log(`[plans] ${created} plan(es) por defecto creados`);
  return created;
}
