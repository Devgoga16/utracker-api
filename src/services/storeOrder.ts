import { Types } from 'mongoose';
import { Customer } from '../models/Customer';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { WorkflowState } from '../models/WorkflowState';
import type { ITenant } from '../models/Tenant';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { buildHistoryEntry } from './stateHistory';
import { notifyOwnerNewOrder, notifyCustomerNewOrder, sessionForTenant } from './whatsapp';

export interface StoreOrderItemInput {
  productId: string;
  quantity: number;
  variant?: string;
}

export interface StoreOrderInput {
  customer?: { name?: string; phone?: string; email?: string };
  items?: StoreOrderItemInput[];
  type?: string;
  address?: string;
  reference?: string;
  scheduledFor?: { date: string; franja?: 'morning' | 'afternoon' | 'evening' };
  notes?: string;
  /** Comprobante del adelanto, ya subido por el endpoint público. */
  advanceProofUrl?: string;
}

/** Cuánto adelanto pide una línea, según cómo lo configuró el dueño. */
export function advanceForLine(
  product: { requiresAdvance?: boolean; advanceType?: string; advanceValue?: number },
  unitPrice: number,
  quantity: number,
): number {
  if (!product.requiresAdvance) return 0;
  const value = product.advanceValue ?? 0;
  if (value <= 0) return 0;

  const raw =
    product.advanceType === 'fixed' ? value * quantity : (unitPrice * quantity * value) / 100;

  // Nunca más que el precio de la línea: un adelanto mayor al total no existe.
  return Math.min(Math.round(raw * 100) / 100, unitPrice * quantity);
}

/**
 * Convierte un carrito en líneas de pedido con precios y adelanto del momento.
 *
 * Se lee el catálogo vivo, nunca lo que mandó el navegador: entre que el
 * cliente armó el carrito y confirmó pudieron cambiar precios o stock.
 */
export async function priceCart(tenantId: Types.ObjectId, itemsInput: StoreOrderItemInput[]) {
  const products = await Product.find({
    _id: { $in: itemsInput.map((i) => i.productId) },
    tenant: tenantId,
    isActive: true,
  });
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const lines = itemsInput.map((input) => {
    const product = byId.get(input.productId);
    if (!product) throw ApiError.conflict('Un producto de tu pedido ya no está disponible');

    const quantity = Math.floor(Number(input.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) {
      throw ApiError.badRequest(`Cantidad inválida para "${product.name}"`);
    }

    // El stock se valida acá aunque el descuento ocurra después, en el estado
    // del workflow que lo descuenta: así no se aceptan pedidos imposibles.
    if (product.trackStock && quantity > (product.stock ?? 0)) {
      throw ApiError.conflict(`Solo quedan ${product.stock ?? 0} unidades de "${product.name}"`);
    }

    const variant = input.variant
      ? product.variants.find((v) => v.name === input.variant)
      : undefined;
    if (input.variant && !variant) {
      throw ApiError.badRequest(`La opción "${input.variant}" ya no existe en "${product.name}"`);
    }

    const unitPrice = product.price + (variant?.priceModifier ?? 0);

    return {
      product: product._id,
      name: product.name,
      unitPrice,
      quantity,
      variant: variant?.name,
      advance: advanceForLine(product, unitPrice, quantity),
      imageUrl: product.images?.[0],
      preparationDays: product.preparationDays ?? 0,
    };
  });

  const totalAmount = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const advanceDue = Math.round(lines.reduce((sum, l) => sum + l.advance, 0) * 100) / 100;
  const maxPrepDays = Math.max(0, ...lines.map((l) => l.preparationDays));

  return { lines, totalAmount, advanceDue, maxPrepDays };
}

/**
 * Crea un pedido desde cualquier vitrina pública: la tienda de uTracker o la
 * web de un tercero que use el storefront API.
 *
 * Vive acá y no en un controlador porque las dos entradas deben validar y
 * cobrar exactamente igual; si se duplicara, una de las dos se quedaría atrás.
 */
export async function createPublicOrder(
  tenant: ITenant,
  input: StoreOrderInput,
  source: string,
): Promise<{ orderId: Types.ObjectId; trackingToken: string; trackingUrl: string }> {
  const allowed = tenant.deliveryTypes ?? [];
  if (!allowed.length) {
    throw ApiError.badRequest('Esta tienda no acepta pedidos en línea por ahora.');
  }

  const { customer: customerData, items: itemsInput, address, reference, scheduledFor, notes } =
    input;

  if (!customerData?.name?.trim() || !customerData?.phone?.trim()) {
    throw ApiError.badRequest('Nombre y teléfono son requeridos');
  }
  if (!itemsInput?.length) throw ApiError.badRequest('Tu pedido está vacío');

  const resolvedType = input.type ?? allowed[0];
  if (!allowed.includes(resolvedType as 'pickup' | 'delivery_own')) {
    throw ApiError.badRequest('Esa forma de entrega no está disponible en esta tienda');
  }
  if (resolvedType !== 'pickup' && !address?.trim()) {
    throw ApiError.badRequest('Necesitamos tu dirección para el delivery');
  }

  const { lines, totalAmount, advanceDue, maxPrepDays } = await priceCart(
    tenant._id,
    itemsInput,
  );

  if (advanceDue > 0 && !input.advanceProofUrl) {
    throw ApiError.badRequest('Este pedido necesita el comprobante del adelanto');
  }

  /**
   * El pedido no puede estar listo antes que el producto que más demora. Se
   * compara en texto ISO porque las fechas llegan como "2026-10-08", sin hora
   * ni zona: pasarlas por Date solo abriría la puerta a corrimientos.
   */
  if (!scheduledFor?.date) throw ApiError.badRequest('Elige la fecha de entrega o recojo');
  const earliest = new Date();
  earliest.setDate(earliest.getDate() + maxPrepDays);
  const earliestIso = earliest.toISOString().slice(0, 10);
  if (scheduledFor.date < earliestIso) {
    throw ApiError.badRequest(
      maxPrepDays > 0
        ? `Este pedido necesita ${maxPrepDays} día(s) de preparación: elige una fecha desde el ${earliestIso}`
        : 'La fecha elegida ya pasó',
    );
  }

  const [initialFulfillment, initialPayment] = await Promise.all([
    WorkflowState.findOne({ tenant: tenant._id, kind: 'fulfillment', isInitial: true }),
    WorkflowState.findOne({ tenant: tenant._id, kind: 'payment', isInitial: true }),
  ]);
  if (!initialFulfillment || !initialPayment) {
    throw ApiError.badRequest('El negocio no tiene su workflow configurado');
  }

  let customer = await Customer.findOne({ tenant: tenant._id, phone: customerData.phone.trim() });
  if (!customer) {
    customer = await Customer.create({
      tenant: tenant._id,
      name: customerData.name.trim(),
      phone: customerData.phone.trim(),
      email: customerData.email?.trim() || undefined,
      addresses: address?.trim() ? [{ address: address.trim(), reference }] : [],
    });
  }

  const order = await Order.create({
    tenant: tenant._id,
    customer: customer._id,
    // `advance`, `imageUrl` y `preparationDays` son de cálculo: no van al pedido.
    items: lines.map((l) => ({
      product: l.product,
      name: l.name,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      variant: l.variant,
    })),
    totalAmount,
    type: resolvedType as 'pickup' | 'delivery_own',
    delivery: resolvedType === 'pickup' ? undefined : { address: address?.trim(), reference },
    scheduledFor,
    fulfillmentState: initialFulfillment._id,
    paymentState: initialPayment._id,
    stateHistory: [buildHistoryEntry(initialFulfillment), buildHistoryEntry(initialPayment)],
    /**
     * El adelanto entra sin validar: el pedido queda en el estado inicial y el
     * estado de pago no se mueve hasta que el negocio confirme que llegó.
     */
    payments:
      advanceDue > 0
        ? [
            {
              kind: 'advance' as const,
              amount: advanceDue,
              proofImageUrl: input.advanceProofUrl,
              validated: false,
              registeredAt: new Date(),
            },
          ]
        : [],
    createdVia: 'store',
    notes: notes?.trim() || undefined,
  });

  const created = order as unknown as { _id: Types.ObjectId; trackingToken: string };

  const notifyItems = lines.map((l) => ({
    name: l.variant ? `${l.name} (${l.variant})` : l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
  }));

  // La sesion del negocio: propia si la tiene, compartida si no.
  const session = await sessionForTenant(tenant._id);

  if (tenant.phone) {
    notifyOwnerNewOrder({
      ownerPhone: tenant.phone,
      customerName: customer.name,
      customerPhone: customer.phone,
      items: notifyItems,
      total: totalAmount,
      source,
      session,
    });
  }

  notifyCustomerNewOrder({
    customerPhone: customer.phone,
    customerName: customer.name,
    businessName: tenant.name,
    items: notifyItems,
    total: totalAmount,
    trackingToken: created.trackingToken,
    advance: advanceDue > 0 ? { amount: advanceDue, validated: false } : undefined,
    delivery: { type: resolvedType, address: address?.trim() },
    scheduledFor,
    session,
  });

  return {
    orderId: created._id,
    trackingToken: created.trackingToken,
    trackingUrl: `${env.frontendUrl}/track/${created.trackingToken}`,
  };
}
