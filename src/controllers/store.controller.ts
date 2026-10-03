import { Request, Response } from 'express';
import { Tenant } from '../models/Tenant';
import { Product } from '../models/Product';
import { Campaign } from '../models/Campaign';
import { ProductFilter } from '../models/ProductFilter';
import { Customer } from '../models/Customer';
import { Order } from '../models/Order';
import { WorkflowState } from '../models/WorkflowState';
import { env, isStorageConfigured } from '../config/env';
import { uploadImage } from '../services/storage';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { buildHistoryEntry } from '../services/stateHistory';
import { notifyOwnerNewOrder, notifyCustomerNewOrder } from '../services/whatsapp';

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
    product.advanceType === 'fixed'
      ? value * quantity
      : (unitPrice * quantity * value) / 100;

  // Nunca más que el precio de la línea: un adelanto mayor al total no existe.
  return Math.min(Math.round(raw * 100) / 100, unitPrice * quantity);
}

export const getStoreCatalog = asyncHandler(async (req: Request, res: Response) => {
  // Endpoint publico: solo los campos que el cliente necesita ver.
  const tenant = await Tenant.findOne({ slug: req.params.slug, isActive: true })
    .select(
      'name slug logoUrl phone brandColor schedule deliveryTypes deliveryFranjas paymentMethods',
    )
    .lean();
  if (!tenant) throw ApiError.notFound('Store not found');

  const products = await Product.find({ tenant: tenant._id, isActive: true })
    .sort({ createdAt: -1 })
    .lean();

  // Include campaigns that are active or upcoming (not ended/cancelled)
  const now = new Date();
  const campaigns = await Campaign.find({
    tenant: tenant._id,
    status: { $in: ['active', 'draft'] },
    endDate: { $gt: now },
  })
    .sort({ startDate: 1 })
    .lean();

  // Solo los filtros que algún producto visible usa: mostrar uno vacío
  // ofrecería al cliente una opción que no devuelve nada.
  const usedFilterIds = new Set(
    products.flatMap((p) => (p.attributes ?? []).map((a) => a.filter.toString())),
  );
  const allFilters = await ProductFilter.find({ tenant: tenant._id })
    .sort({ position: 1, name: 1 })
    .lean();
  const filters = allFilters.filter((f) => usedFilterIds.has(f._id.toString()));

  res.json({ tenant, products, campaigns, filters });
});

/**
 * Subida pública del comprobante, antes de confirmar el pedido.
 *
 * Va sin auth porque quien paga es un cliente anónimo, pero queda acotada: el
 * slug fija el tenant, el servicio valida tipo y tamaño, y la clave que genera
 * es aleatoria, así que no se puede escribir fuera de la carpeta del negocio.
 */
export const uploadStoreProof = asyncHandler(async (req: Request, res: Response) => {
  const tenant = await Tenant.findOne({ slug: req.params.slug, isActive: true })
    .select('_id deliveryTypes')
    .lean();
  if (!tenant) throw ApiError.notFound('Store not found');

  // Sin compra en línea no hay comprobante que subir.
  if (!(tenant.deliveryTypes ?? []).length) {
    throw ApiError.badRequest('Esta tienda no acepta pedidos en línea');
  }
  if (!isStorageConfigured()) {
    throw ApiError.serviceUnavailable('La subida de imágenes no está disponible');
  }

  const file = req.file;
  if (!file) throw ApiError.badRequest('No se recibió ninguna imagen');

  const uploaded = await uploadImage(file.buffer, tenant._id.toString(), 'store-proofs');
  res.status(201).json({ url: uploaded.url });
});

interface StoreOrderItemInput {
  productId: string;
  quantity: number;
  variant?: string;
}

/**
 * Checkout público del catálogo.
 *
 * Es el gemelo de confirmCampaignOrder, pero contra el catálogo vivo: acá los
 * precios y el stock se leen del producto en este instante, no de una foto
 * congelada, porque entre que el cliente cargó la página y confirmó pudieron
 * cambiar.
 */
export const createStoreOrder = asyncHandler(async (req: Request, res: Response) => {
  const tenant = await Tenant.findOne({ slug: req.params.slug, isActive: true });
  if (!tenant) throw ApiError.notFound('Store not found');

  const allowed = tenant.deliveryTypes ?? [];
  if (!allowed.length) {
    throw ApiError.badRequest('Esta tienda no acepta pedidos en línea por ahora.');
  }

  const {
    customer: customerData,
    items: itemsInput,
    type,
    address,
    reference,
    scheduledFor,
    notes,
    advanceProofUrl,
  } = req.body as {
    customer?: { name?: string; phone?: string; email?: string };
    items?: StoreOrderItemInput[];
    type?: string;
    address?: string;
    reference?: string;
    scheduledFor?: { date: string; franja: 'morning' | 'afternoon' | 'evening' };
    notes?: string;
    /** Comprobante del adelanto, ya subido a R2 por el endpoint público. */
    advanceProofUrl?: string;
  };

  if (!customerData?.name?.trim() || !customerData?.phone?.trim()) {
    throw ApiError.badRequest('Nombre y teléfono son requeridos');
  }
  if (!itemsInput?.length) throw ApiError.badRequest('Tu pedido está vacío');

  const resolvedType = type ?? allowed[0];
  if (!allowed.includes(resolvedType as 'pickup' | 'delivery_own')) {
    throw ApiError.badRequest('Esa forma de entrega no está disponible en esta tienda');
  }
  if (resolvedType !== 'pickup' && !address?.trim()) {
    throw ApiError.badRequest('Necesitamos tu dirección para el delivery');
  }

  const products = await Product.find({
    _id: { $in: itemsInput.map((i) => i.productId) },
    tenant: tenant._id,
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
      throw ApiError.conflict(
        `Solo quedan ${product.stock ?? 0} unidades de "${product.name}"`,
      );
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
    };
  });

  const totalAmount = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

  /**
   * El adelanto se recalcula acá, nunca se confía en el que mandó el cliente:
   * el navegador solo lo muestra, el servidor manda.
   */
  const advanceDue = Math.round(lines.reduce((sum, l) => sum + l.advance, 0) * 100) / 100;
  if (advanceDue > 0 && !advanceProofUrl) {
    throw ApiError.badRequest('Este pedido necesita el comprobante del adelanto');
  }

  /**
   * El pedido no puede estar listo antes que el producto que más demora, así
   * que la fecha elegida se valida contra eso. Se compara en texto ISO porque
   * las fechas vienen como "2026-10-08" y no tienen hora ni zona.
   */
  const maxPrepDays = Math.max(
    0,
    ...itemsInput.map((i) => byId.get(i.productId)?.preparationDays ?? 0),
  );
  if (!scheduledFor?.date) {
    throw ApiError.badRequest('Elige la fecha de entrega o recojo');
  }
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
    // `advance` es de cálculo: no viaja al pedido, va en el pago.
    items: lines.map(({ advance: _advance, ...line }) => line),
    totalAmount,
    type: resolvedType as 'pickup' | 'delivery_own',
    delivery:
      resolvedType === 'pickup' ? undefined : { address: address?.trim(), reference },
    scheduledFor,
    fulfillmentState: initialFulfillment._id,
    paymentState: initialPayment._id,
    stateHistory: [buildHistoryEntry(initialFulfillment), buildHistoryEntry(initialPayment)],
    /**
     * Entra sin validar a propósito: el pedido queda en el estado inicial
     * ("Recibido") y el estado de pago no se mueve hasta que el negocio
     * confirme que el dinero llegó.
     */
    payments:
      advanceDue > 0
        ? [
            {
              kind: 'advance' as const,
              amount: advanceDue,
              proofImageUrl: advanceProofUrl,
              validated: false,
              registeredAt: new Date(),
            },
          ]
        : [],
    createdVia: 'store',
    notes: notes?.trim() || undefined,
  });

  const created = order as unknown as { _id: unknown; trackingToken: string };

  const notifyItems = lines.map((l) => ({
    name: l.variant ? `${l.name} (${l.variant})` : l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
  }));

  if (tenant.phone) {
    notifyOwnerNewOrder({
      ownerPhone: tenant.phone,
      customerName: customer.name,
      customerPhone: customer.phone,
      items: notifyItems,
      total: totalAmount,
      source: 'tienda online',
    });
  }

  // Su comprobante de compra: el cliente no tiene panel donde mirarlo.
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
  });

  res.status(201).json({
    orderId: created._id,
    trackingUrl: `${env.frontendUrl}/track/${created.trackingToken}`,
  });
});
