import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Product } from '../models/Product';
import { ProductFilter } from '../models/ProductFilter';
import { Campaign } from '../models/Campaign';
import { Tenant } from '../models/Tenant';
import { CheckoutSession, generateSessionToken } from '../models/CheckoutSession';
import { env, isStorageConfigured } from '../config/env';
import { uploadImage } from '../services/storage';
import { createPublicOrder, priceCart } from '../services/storeOrder';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/** Minutos que vive una sesión de checkout sin confirmarse. */
const SESSION_TTL_MINUTES = 60;

/**
 * Qué puede saber una web externa de un producto.
 *
 * Se arma campo por campo en vez de mandar el documento: así un campo interno
 * que se agregue mañana al modelo no se filtra solo a terceros.
 */
function publicProduct(p: Record<string, any>) {
  return {
    id: p._id,
    kind: p.kind,
    name: p.name,
    description: p.description,
    price: p.price,
    pricingMode: p.pricingMode,
    images: p.images ?? [],
    category: p.category,
    variants: (p.variants ?? []).map((v: any) => ({
      name: v.name,
      priceModifier: v.priceModifier,
      price: p.price + (v.priceModifier ?? 0),
    })),
    attributes: (p.attributes ?? []).map((a: any) => ({
      filter: a.filter,
      values: a.values,
    })),
    // Lo que la web necesita para mostrar disponibilidad sin exponer el conteo
    // exacto cuando el negocio no lleva control.
    inStock: p.trackStock ? (p.stock ?? 0) > 0 : true,
    stock: p.trackStock ? (p.stock ?? 0) : null,
    preparationDays: p.preparationDays ?? 0,
    requiresAdvance: Boolean(p.requiresAdvance),
    advanceType: p.advanceType,
    advanceValue: p.advanceValue,
  };
}

// GET /storefront/config
export const storefrontConfig = asyncHandler(async (req: Request, res: Response) => {
  const { tenant } = req.storefront!;

  const filters = await ProductFilter.find({ tenant: tenant._id })
    .sort({ position: 1, name: 1 })
    .lean();

  res.json({
    store: {
      name: tenant.name,
      slug: tenant.slug,
      logoUrl: tenant.logoUrl,
      brandColor: tenant.brandColor,
      phone: tenant.phone,
      schedule: tenant.schedule ?? [],
      // Vacío significa que la tienda no acepta pedidos en línea.
      deliveryTypes: tenant.deliveryTypes ?? [],
      deliveryFranjas: tenant.deliveryFranjas ?? [],
      acceptsOnlineOrders: (tenant.deliveryTypes ?? []).length > 0,
    },
    filters: filters.map((f) => ({ id: f._id, name: f.name, values: f.values })),
    checkoutBaseUrl: `${env.frontendUrl}/checkout`,
  });
});

// GET /storefront/products
export const storefrontProducts = asyncHandler(async (req: Request, res: Response) => {
  const { tenant } = req.storefront!;

  const products = await Product.find({ tenant: tenant._id, isActive: true })
    .sort({ createdAt: -1 })
    .lean();

  const categories = Array.from(
    new Set(products.map((p) => p.category).filter((c): c is string => Boolean(c))),
  ).sort();

  res.json({ products: products.map(publicProduct), categories, total: products.length });
});

// GET /storefront/campaigns
export const storefrontCampaigns = asyncHandler(async (req: Request, res: Response) => {
  const { tenant } = req.storefront!;

  const campaigns = await Campaign.find({
    tenant: tenant._id,
    status: { $in: ['active', 'draft'] },
    endDate: { $gt: new Date() },
  })
    .sort({ startDate: 1 })
    .lean();

  res.json({
    campaigns: campaigns.map((c) => ({
      id: c._id,
      name: c.name,
      description: c.description,
      startDate: c.startDate,
      endDate: c.endDate,
      status: c.status,
      // La campaña tiene su propia página pública, con su stock aparte.
      url: `${env.frontendUrl}/c/${c.token}`,
      items: c.items.map((i) => ({
        name: i.name,
        price: i.price,
        imageUrl: i.imageUrl,
        available: Math.max(0, i.stock - i.sold),
      })),
    })),
  });
});

/**
 * POST /storefront/checkout
 *
 * El tercero manda el carrito y recibe la URL de la pantalla de pago. El
 * precio se valida ya acá para que el error salga en su web, no después de
 * haber mandado al cliente a otra pantalla.
 */
export const createCheckoutSession = asyncHandler(async (req: Request, res: Response) => {
  const { tenant, apiKeyId } = req.storefront!;

  if (!(tenant.deliveryTypes ?? []).length) {
    throw ApiError.badRequest('Esta tienda no acepta pedidos en línea por ahora.');
  }

  const { items, returnUrl } = req.body as {
    items?: { productId: string; quantity: number; variant?: string }[];
    returnUrl?: string;
  };
  if (!items?.length) throw ApiError.badRequest('El carrito está vacío');
  if (items.length > 50) throw ApiError.badRequest('Demasiados productos en un solo pedido');

  // Valida existencia, stock y variantes. Lanza si algo no cuadra.
  const { totalAmount, advanceDue } = await priceCart(tenant._id, items);

  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000);
  const session = await CheckoutSession.create({
    tenant: tenant._id,
    token: generateSessionToken(),
    apiKey: new Types.ObjectId(apiKeyId),
    items: items.map((i) => ({
      product: i.productId,
      quantity: Math.floor(Number(i.quantity)),
      variant: i.variant,
    })),
    returnUrl: returnUrl?.trim() || undefined,
    expiresAt,
  });

  res.status(201).json({
    sessionId: session.token,
    checkoutUrl: `${env.frontendUrl}/checkout/${session.token}`,
    totalAmount,
    advanceDue,
    expiresAt,
  });
});

/** Carga la sesión y la deja lista para usar, o explica por qué no sirve. */
async function loadOpenSession(token: string) {
  const session = await CheckoutSession.findOne({ token });
  if (!session) throw ApiError.notFound('Esta sesión de compra no existe');

  if (session.status === 'completed') {
    throw ApiError.conflict('Este pedido ya fue confirmado');
  }
  if (session.status === 'expired' || session.expiresAt < new Date()) {
    if (session.status !== 'expired') {
      session.status = 'expired';
      await session.save();
    }
    throw ApiError.conflict('Esta sesión de compra venció. Vuelve a armar tu pedido.');
  }

  const tenant = await Tenant.findOne({ _id: session.tenant, isActive: true });
  if (!tenant) throw ApiError.notFound('La tienda no está disponible');

  return { session, tenant };
}

/**
 * GET /storefront/checkout/:token
 *
 * Público y sin llave: lo abre el navegador del comprador. El token de sesión
 * es la credencial, igual que el de seguimiento de un pedido.
 */
export const getCheckoutSession = asyncHandler(async (req: Request, res: Response) => {
  const { session, tenant } = await loadOpenSession(String(req.params.token));

  const { lines, totalAmount, advanceDue, maxPrepDays } = await priceCart(
    tenant._id,
    session.items.map((i) => ({
      productId: i.product.toString(),
      quantity: i.quantity,
      variant: i.variant,
    })),
  );

  res.json({
    store: {
      name: tenant.name,
      slug: tenant.slug,
      logoUrl: tenant.logoUrl,
      brandColor: tenant.brandColor,
      phone: tenant.phone,
      deliveryTypes: tenant.deliveryTypes ?? [],
      deliveryFranjas: tenant.deliveryFranjas ?? [],
      paymentMethods: tenant.paymentMethods ?? [],
    },
    items: lines.map((l) => ({
      name: l.name,
      variant: l.variant,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      imageUrl: l.imageUrl,
    })),
    totalAmount,
    advanceDue,
    maxPrepDays,
    returnUrl: session.returnUrl,
    expiresAt: session.expiresAt,
  });
});

// POST /storefront/checkout/:token/proof — comprobante del adelanto.
export const uploadCheckoutProof = asyncHandler(async (req: Request, res: Response) => {
  const { tenant } = await loadOpenSession(String(req.params.token));

  if (!isStorageConfigured()) {
    throw ApiError.serviceUnavailable('La subida de imágenes no está disponible');
  }
  const file = req.file;
  if (!file) throw ApiError.badRequest('No se recibió ninguna imagen');

  const uploaded = await uploadImage(file.buffer, tenant._id.toString(), 'store-proofs');
  res.status(201).json({ url: uploaded.url });
});

/**
 * POST /storefront/checkout/:token/confirm
 *
 * Crea el pedido de verdad. Usa el mismo servicio que la tienda propia, así
 * las dos rutas validan y cobran igual.
 */
export const confirmCheckoutSession = asyncHandler(async (req: Request, res: Response) => {
  const { session, tenant } = await loadOpenSession(String(req.params.token));

  const result = await createPublicOrder(
    tenant,
    {
      ...req.body,
      // El carrito manda el de la sesión, no el del navegador: si no, se
      // podría cambiar lo pedido entre crear la sesión y confirmarla.
      items: session.items.map((i) => ({
        productId: i.product.toString(),
        quantity: i.quantity,
        variant: i.variant,
      })),
    },
    'tienda integrada',
  );

  session.status = 'completed';
  session.resultingOrder = result.orderId;
  await session.save();

  res.status(201).json({
    orderId: result.orderId,
    trackingUrl: result.trackingUrl,
    returnUrl: session.returnUrl,
  });
});
