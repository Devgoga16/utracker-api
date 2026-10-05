import { Request, Response } from 'express';
import { Tenant } from '../models/Tenant';
import { Product } from '../models/Product';
import { Campaign } from '../models/Campaign';
import { ProductFilter } from '../models/ProductFilter';
import { isStorageConfigured } from '../config/env';
import { uploadImage } from '../services/storage';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { createPublicOrder } from '../services/storeOrder';

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

  // Las reglas viven en el servicio: la tienda propia y la integrada deben
  // validar y cobrar igual, y duplicarlas garantizaria que una se atrase.
  const result = await createPublicOrder(tenant, req.body, 'tienda online');

  res.status(201).json({ orderId: result.orderId, trackingUrl: result.trackingUrl });
});
