import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { Tenant } from '../models/Tenant';
import { getEntitlements } from '../services/entitlements';

/** Más que esto ya no se lee como una lista de socios, sino como un directorio. */
const MAX_PARTNERS = 60;

/**
 * GET /showcase — los negocios que aceptaron aparecer como socios.
 *
 * Público y sin datos sensibles: nombre, logo, color y el link a su tienda.
 * Solo los que dieron su permiso (`showcase`) y siguen activos: mostrar como
 * socio a un negocio suspendido sería mostrar algo que ya no es cierto.
 */
export const listShowcase = asyncHandler(async (_req: Request, res: Response) => {
  const tenants = await Tenant.find({ showcase: true, isActive: true })
    .select('name slug logoUrl brandColor')
    .sort({ name: 1 })
    .limit(MAX_PARTNERS)
    .lean();

  const partners = [];
  for (const tenant of tenants) {
    const ent = await getEntitlements(String(tenant._id));
    if (ent.readOnly) continue;

    partners.push({
      name: tenant.name,
      slug: tenant.slug,
      logoUrl: tenant.logoUrl ?? null,
      brandColor: tenant.brandColor ?? null,
      // El link solo si la tienda existe: sin la funcionalidad devuelve 404.
      storeUrl: ent.features.publicStore ? `/store/${tenant.slug}` : null,
    });
  }

  // Los que tienen logo primero: la fila se lee mejor con logos que con iniciales.
  partners.sort((a, b) => Number(Boolean(b.logoUrl)) - Number(Boolean(a.logoUrl)));

  // Un minuto: le ahorra consultas a cada visita, y cuando alguien prende o
  // apaga un socio el cambio se ve casi enseguida.
  res.set('Cache-Control', 'public, max-age=60');
  res.json(partners);
});
