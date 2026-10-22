import { Types } from 'mongoose';
import { Campaign } from '../models/Campaign';
import { IOrder } from '../models/Order';
import { Product } from '../models/Product';
import { StockMovement } from '../models/StockMovement';
import { IWorkflowState, WorkflowState } from '../models/WorkflowState';
import { buildHistoryEntry } from './stateHistory';
import { checkLowStock } from './stockAlerts';

/**
 * Cuándo un pedido tiene su stock descontado, en una sola regla:
 *
 *   El stock está fuera mientras el pedido esté en el estado marcado con
 *   «Descontar stock» o en uno posterior, y no esté cancelado.
 *
 * Antes cada paso por el estado marcado restaba otra vez —ir y volver de
 * «En preparación» descontaba el doble—, y un pedido que saltaba directo a
 * «Entregado» no descontaba nunca. Ahora no se suma ni se resta por evento:
 * se compara lo que el pedido debería tener descontado con lo que de verdad
 * descontó (sus movimientos) y se corrige la diferencia. Llamarlo dos veces
 * no hace nada la segunda.
 */

/** Unidades por producto. */
function quantitiesByProduct(items: { product?: Types.ObjectId; quantity: number }[]) {
  const map = new Map<string, number>();
  for (const line of items) {
    if (!line.product) continue;
    const key = line.product.toString();
    map.set(key, (map.get(key) ?? 0) + line.quantity);
  }
  return map;
}

/** Desde qué estado se descuenta: el primero marcado, por su lugar en el workflow. */
export function deductionPoint(states: IWorkflowState[]): IWorkflowState | null {
  return [...states]
    .filter((s) => s.kind === 'fulfillment' && s.deductsStock)
    .sort((a, b) => a.position - b.position)[0] ?? null;
}

function shouldBeDeducted(
  order: Pick<IOrder, 'createdVia'>,
  current: IWorkflowState | undefined,
  point: IWorkflowState | null,
) {
  if (!current || current.isCancellation) return false;
  // Una venta de mostrador sale en la mano del cliente: siempre descontada.
  if (order.createdVia === 'pos') return true;
  if (!point) return false;
  return current.position >= point.position;
}

/**
 * Deja el stock del pedido como corresponde a su estado actual. Devuelve
 * cuántas unidades salieron por producto, para el aviso de stock bajo.
 */
export async function syncOrderStock(
  order: Pick<IOrder, '_id' | 'items' | 'createdVia' | 'fulfillmentState'>,
  tenantId: string,
  userId?: string,
) {
  const states = await WorkflowState.find({ tenant: tenantId, kind: 'fulfillment' });
  const current = states.find((s) => s._id.equals(order.fulfillmentState));
  const deducted = shouldBeDeducted(order, current, deductionPoint(states));

  const wanted = quantitiesByProduct(order.items);
  if (!wanted.size) return;

  // Solo los productos que llevan stock. Si a uno se le apagó el control, se deja en paz.
  const tracked = await Product.find({
    _id: { $in: [...wanted.keys()] },
    tenant: tenantId,
    trackStock: true,
  }).select('_id');

  const movements = await StockMovement.find({ tenant: tenantId, order: order._id }).lean();
  const net = new Map<string, number>();
  for (const m of movements) {
    const key = m.product.toString();
    net.set(key, (net.get(key) ?? 0) + m.delta);
  }

  const sold: { productId: string; soldUnits: number }[] = [];
  for (const product of tracked) {
    const key = product._id.toString();
    const target = deducted ? -(wanted.get(key) ?? 0) : 0;
    const diff = target - (net.get(key) ?? 0);
    if (!diff) continue;

    await Promise.all([
      Product.updateOne({ _id: product._id, tenant: tenantId }, { $inc: { stock: diff } }),
      StockMovement.create({
        tenant: tenantId,
        product: product._id,
        order: order._id,
        delta: diff,
        reason: diff < 0 ? 'order' : 'adjustment',
        note: diff < 0
          ? undefined
          : current?.isCancellation
            ? 'Devuelto: pedido cancelado'
            : 'Devuelto: el pedido volvió a un estado anterior',
        createdBy: userId ? new Types.ObjectId(userId) : undefined,
      }),
    ]);
    if (diff < 0) sold.push({ productId: key, soldUnits: -diff });
  }

  if (sold.length) void checkLowStock(tenantId, sold);
}

/** Devuelve (o vuelve a tomar) las unidades que el pedido tenía reservadas en su campaña. */
async function syncCampaignStock(
  order: Pick<IOrder, 'campaign' | 'items' | 'stockReleased'>,
  tenantId: string,
  cancelled: boolean,
) {
  if (!order.campaign || cancelled === Boolean(order.stockReleased)) return;

  const campaign = await Campaign.findOne({ _id: order.campaign, tenant: tenantId });
  if (campaign) {
    const sign = cancelled ? -1 : 1;
    for (const [productId, qty] of quantitiesByProduct(order.items)) {
      const item = campaign.items.find((i) => i.product.toString() === productId);
      if (item) item.sold = Math.max(0, item.sold + sign * qty);
    }
    await campaign.save();
  }
}

/**
 * Mueve un pedido a un estado del recorrido, con todo lo que eso arrastra:
 * el stock, la campaña y el historial. Es el único camino para cambiar el
 * estado de un pedido; así ninguna pantalla se olvida de una parte.
 */
export async function applyFulfillmentState(
  order: IOrder & {
    stateHistory: { push: (e: ReturnType<typeof buildHistoryEntry>) => unknown };
  },
  state: IWorkflowState,
  tenantId: string,
  userId?: string,
  opts: { link?: string; note?: string } = {},
) {
  order.fulfillmentState = state._id;
  order.fulfillmentLink = opts.link?.trim() || undefined;

  await syncCampaignStock(order, tenantId, state.isCancellation);
  // `stockReleased` queda solo para la campaña: el inventario se calcula de cero.
  order.stockReleased = state.isCancellation;
  await syncOrderStock(order, tenantId, userId);

  order.stateHistory.push({ ...buildHistoryEntry(state, userId), note: opts.note?.trim() || undefined });
}
