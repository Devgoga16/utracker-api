import { Product } from '../models/Product';
import { Tenant } from '../models/Tenant';
import { sendWhatsappMessage, sessionForTenant } from './whatsapp';

/** Umbral efectivo: el del producto si lo tiene, si no el del negocio. */
function thresholdFor(
  product: { lowStockThreshold?: number },
  tenantDefault: number,
): number {
  return product.lowStockThreshold ?? tenantDefault;
}

/**
 * Avisa al dueño cuando el stock de un producto acaba de caer al umbral.
 *
 * Solo dispara en el cruce —antes estaba por encima, ahora no— y no en cada
 * venta posterior: si no, vender las últimas cinco unidades mandaría cinco
 * mensajes y el dueño terminaría ignorándolos.
 *
 * Nunca lanza: una alerta que falla no puede tumbar el pedido que la originó.
 */
export async function checkLowStock(
  tenantId: string,
  changes: { productId: string; soldUnits: number }[],
): Promise<void> {
  try {
    if (!changes.length) return;

    const [tenant, products] = await Promise.all([
      Tenant.findById(tenantId).select('name phone lowStockThreshold').lean(),
      Product.find({
        _id: { $in: changes.map((c) => c.productId) },
        tenant: tenantId,
        trackStock: true,
      })
        .select('name stock lowStockThreshold')
        .lean(),
    ]);

    if (!tenant?.phone) return;
    const tenantDefault = tenant.lowStockThreshold ?? 5;

    const crossed: { name: string; stock: number; threshold: number }[] = [];

    for (const product of products) {
      const change = changes.find((c) => c.productId === product._id.toString());
      if (!change || change.soldUnits <= 0) continue;

      const now = product.stock ?? 0;
      const before = now + change.soldUnits;
      const limit = thresholdFor(product, tenantDefault);

      if (now <= limit && before > limit) {
        crossed.push({ name: product.name, stock: now, threshold: limit });
      }
    }

    if (!crossed.length) return;

    const lines = [
      '📦 *Stock bajo*',
      '',
      ...crossed.map((c) =>
        c.stock <= 0
          ? `• ${c.name} — *agotado*`
          : `• ${c.name} — quedan *${c.stock}* (avisas desde ${c.threshold})`,
      ),
      '',
      'Conviene reponer antes de que te lo pidan.',
    ];

    await sendWhatsappMessage(tenant.phone, lines.join('\n'));
  } catch (err) {
    console.error('[stock] No se pudo avisar del stock bajo:', err);
  }
}
