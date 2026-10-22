/**
 * Catálogo de funcionalidades de uTracker: la lista cerrada de lo que un plan
 * puede incluir.
 *
 * Es la única fuente de verdad. Los planes viven en la base de datos, pero sus
 * claves salen de aquí: el formulario del superadmin se dibuja solo con esto, la
 * API rechaza cualquier clave que no esté en la lista, y la página de precios
 * lee las etiquetas de aquí.
 *
 * Una funcionalidad nueva empieza siempre en este archivo. Antes estaba repetida
 * en seis lugares —el schema de Mongoose, el middleware, los tipos del front, y
 * tres constantes en la pantalla de planes— y agregar una era acordarse de todas.
 */

export type FeatureKind = 'flag' | 'limit';

export type FeatureGroup =
  | 'limits'
  | 'operation'
  | 'payments'
  | 'catalog'
  | 'online'
  | 'communication'
  | 'brand'
  | 'support';

export interface FeatureDefinition {
  kind: FeatureKind;
  /** Lo que ve el superadmin y, si el plan es público, el negocio. */
  label: string;
  /** Qué implica de verdad activarla. Se muestra debajo de la etiqueta. */
  hint?: string;
  group: FeatureGroup;
  /**
   * Dónde se aplica de verdad cuando está apagada.
   *
   * - 'api': el servidor la rechaza. Es la única que no se puede esquivar.
   * - 'ui':  el panel la esconde, pero no hay endpoint que bloquear.
   * - 'none': se guarda y no hace nada todavía.
   *
   * Importa distinguirlas: vender una funcionalidad que nadie bloquea es
   * prometer un límite que no existe, y en la pantalla de planes sale avisado.
   */
  enforcement: 'api' | 'ui' | 'none';
}

export const FEATURE_GROUP_LABELS: Record<FeatureGroup, string> = {
  limits: 'Límites',
  operation: 'Operación',
  payments: 'Cobros',
  catalog: 'Catálogo',
  online: 'Venta online',
  communication: 'Comunicación',
  brand: 'Marca',
  support: 'Soporte',
};

/** El orden en que se muestran los grupos en el formulario y en las tarjetas. */
export const FEATURE_GROUP_ORDER: FeatureGroup[] = [
  'limits',
  'operation',
  'payments',
  'catalog',
  'online',
  'communication',
  'brand',
  'support',
];

/**
 * Las claves quedaron en camelCase porque así están en los planes que ya
 * existen en la base. Renombrarlas sería migrar cada documento y cada llamada
 * a `can('finances')` del front, a cambio de nada.
 */
export const FEATURES = {
  /* ─────────────── Límites (0 = ilimitado) ─────────────── */

  maxOrdersPerMonth: {
    kind: 'limit',
    label: 'Pedidos por mes',
    hint: 'Se cuentan los creados en el mes en curso, por cualquier vía. Las ventas del punto de venta no cuentan.',
    group: 'limits',
    enforcement: 'api',
  },
  maxCatalogItems: {
    kind: 'limit',
    label: 'Productos activos',
    hint: 'Los inactivos no cuentan.',
    group: 'limits',
    enforcement: 'api',
  },
  maxWorkflowStates: {
    kind: 'limit',
    label: 'Estados del workflow',
    hint: 'Entrega y pago sumados.',
    group: 'limits',
    enforcement: 'api',
  },
  maxCampaigns: {
    kind: 'limit',
    label: 'Campañas activas',
    hint: 'Las finalizadas o canceladas no cuentan.',
    group: 'limits',
    enforcement: 'api',
  },
  maxStoreKeys: {
    kind: 'limit',
    label: 'Llaves de integración',
    hint: 'Para la API de tienda. Las revocadas no cuentan.',
    group: 'limits',
    enforcement: 'api',
  },
  maxMembers: {
    kind: 'limit',
    label: 'Miembros del equipo',
    hint: 'Cuenta los activos más las invitaciones pendientes. El dueño siempre ocupa un lugar.',
    group: 'limits',
    enforcement: 'api',
  },

  /* ─────────────── Operación ─────────────── */

  workflowCustomization: {
    kind: 'flag',
    label: 'Workflow personalizable',
    hint: 'Crear, renombrar y reordenar estados. Sin esto queda el workflow por defecto.',
    group: 'operation',
    enforcement: 'api',
  },
  orderCalendar: {
    kind: 'flag',
    label: 'Calendario de pedidos',
    hint: 'Vista semanal por fecha de entrega.',
    group: 'operation',
    enforcement: 'api',
  },
  deliveryTypes: {
    kind: 'flag',
    label: 'Varios tipos de entrega',
    hint: 'Ofrecer recojo y delivery a la vez. Sin esto, la tienda acepta un solo tipo.',
    group: 'operation',
    enforcement: 'api',
  },
  deliveryAttempts: {
    kind: 'flag',
    label: 'Intentos de entrega',
    hint: 'Registrar que no había nadie y reprogramar.',
    group: 'operation',
    enforcement: 'api',
  },
  pos: {
    kind: 'flag',
    label: 'Punto de venta',
    hint: 'Venta rápida en mostrador, con caja, vuelto y ticket. No emite comprobantes electrónicos.',
    group: 'operation',
    enforcement: 'api',
  },

  /* ─────────────── Cobros ─────────────── */

  advancePayments: {
    kind: 'flag',
    label: 'Adelantos y comprobantes',
    hint: 'Pedir adelanto, recibir la foto del pago y validarlo o rechazarlo.',
    group: 'payments',
    enforcement: 'api',
  },
  receipts: {
    kind: 'flag',
    label: 'Comprobante de compra',
    hint: 'Boleta interna imprimible cuando el pedido está pagado. Se esconde del panel; no hay endpoint que bloquear.',
    group: 'payments',
    enforcement: 'ui',
  },
  finances: {
    kind: 'flag',
    label: 'Panel de finanzas',
    hint: 'Ingresos, cobrado y pendiente por periodo.',
    group: 'payments',
    enforcement: 'api',
  },

  /* ─────────────── Catálogo ─────────────── */

  imageUploads: {
    kind: 'flag',
    label: 'Subida de imágenes',
    hint: 'Fotos de productos, logo y comprobantes.',
    group: 'catalog',
    enforcement: 'api',
  },
  productFilters: {
    kind: 'flag',
    label: 'Filtros de catálogo',
    hint: 'Atributos propios del negocio para filtrar en la tienda.',
    group: 'catalog',
    enforcement: 'api',
  },
  inventory: {
    kind: 'flag',
    label: 'Inventario',
    hint: 'Stock, movimientos y alertas de stock bajo.',
    group: 'catalog',
    enforcement: 'api',
  },

  /* ─────────────── Venta online ─────────────── */

  publicTracking: {
    kind: 'flag',
    label: 'Seguimiento público',
    hint: 'El link donde el cliente ve en qué va su pedido.',
    group: 'online',
    enforcement: 'api',
  },
  publicOrderLinks: {
    kind: 'flag',
    label: 'Links de pedido',
    hint: 'Armar un pedido y mandarlo por WhatsApp para que el cliente lo confirme.',
    group: 'online',
    enforcement: 'api',
  },
  publicStore: {
    kind: 'flag',
    label: 'Tienda pública',
    hint: 'Catálogo con carrito en un link propio, listo para tus redes.',
    group: 'online',
    enforcement: 'api',
  },
  campaigns: {
    kind: 'flag',
    label: 'Campañas',
    hint: 'Ventas por tiempo limitado con stock propio.',
    group: 'online',
    enforcement: 'api',
  },
  storefrontApi: {
    kind: 'flag',
    label: 'API de tienda',
    hint: 'Que una web externa use el catálogo y el checkout hospedado de uTracker.',
    group: 'online',
    enforcement: 'api',
  },

  /* ─────────────── Comunicación ─────────────── */

  whatsappNotifications: {
    kind: 'flag',
    label: 'Notificaciones por WhatsApp',
    hint: 'Avisos automáticos al cliente y al dueño. Cada mensaje tiene costo real.',
    group: 'communication',
    enforcement: 'api',
  },

  /* ─────────────── Marca ─────────────── */

  branding: {
    kind: 'flag',
    label: 'Marca propia',
    hint: 'Logo y color del negocio en la tienda, las campañas y el seguimiento.',
    group: 'brand',
    enforcement: 'api',
  },

  /* ─────────────── Soporte ─────────────── */

  prioritySupport: {
    kind: 'flag',
    label: 'Soporte prioritario',
    hint: 'Sus tickets entran con prioridad alta.',
    group: 'support',
    enforcement: 'api',
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURES;

/** Valor de una funcionalidad: booleano para los flags, entero para los límites. */
export type FeatureValue = boolean | number;

export type FeatureMap = Partial<Record<FeatureKey, FeatureValue>>;

/** Mapa completo, con el valor por defecto donde el plan no define nada. */
export type ResolvedFeatures = Record<FeatureKey, FeatureValue>;

export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export type FlagKey = {
  [K in FeatureKey]: (typeof FEATURES)[K]['kind'] extends 'flag' ? K : never;
}[FeatureKey];

export type LimitKey = {
  [K in FeatureKey]: (typeof FEATURES)[K]['kind'] extends 'limit' ? K : never;
}[FeatureKey];

export const FLAG_KEYS = FEATURE_KEYS.filter((k) => FEATURES[k].kind === 'flag') as FlagKey[];
export const LIMIT_KEYS = FEATURE_KEYS.filter((k) => FEATURES[k].kind === 'limit') as LimitKey[];

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURES, key);
}

/** Apagado: los flags en false, los límites en 0. Ojo: 0 es ilimitado, no cero. */
export function defaultFeatureValue(key: FeatureKey): FeatureValue {
  return FEATURES[key].kind === 'flag' ? false : 0;
}

/**
 * Normaliza un valor que llega de afuera al tipo que corresponde a su clave.
 *
 * Devuelve `null` si el valor no sirve, para que el controlador pueda
 * responder con un error en vez de guardar un booleano donde va un entero.
 */
export function coerceFeatureValue(key: FeatureKey, raw: unknown): FeatureValue | null {
  if (FEATURES[key].kind === 'flag') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === 'false') return raw === 'true';
    return null;
  }

  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(num) || num < 0) return null;
  return num;
}

/** El catálogo en el formato que consume el front, con claves y etiquetas. */
export function featureCatalogPayload() {
  return {
    groups: FEATURE_GROUP_ORDER.map((group) => ({
      key: group,
      label: FEATURE_GROUP_LABELS[group],
      features: FEATURE_KEYS.filter((k) => FEATURES[k].group === group).map((key) => ({
        key,
        ...FEATURES[key],
      })),
    })).filter((g) => g.features.length > 0),
  };
}
