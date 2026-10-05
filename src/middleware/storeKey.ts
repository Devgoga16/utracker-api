import { NextFunction, Request, Response } from 'express';
import { StoreApiKey } from '../models/StoreApiKey';
import { Tenant, ITenant } from '../models/Tenant';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      storefront?: { tenant: ITenant; apiKeyId: string };
    }
  }
}

/**
 * Resuelve de que tienda es la llave publicable que viene en la peticion.
 *
 * Se acepta por cabecera o por query porque el consumidor puede ser desde un
 * fetch de servidor hasta un `<script>` en una landing sin build.
 */
export const requireStoreKey = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const raw =
      req.header('X-Store-Key') ??
      (typeof req.query.key === 'string' ? req.query.key : undefined);

    if (!raw?.trim()) {
      throw ApiError.unauthorized('Falta la llave de tienda (X-Store-Key)');
    }

    const apiKey = await StoreApiKey.findOne({ key: raw.trim() });
    if (!apiKey || apiKey.revokedAt) {
      throw ApiError.unauthorized('Llave de tienda inválida o revocada');
    }

    /**
     * Si el dueno limito dominios, se exige que el navegador declare uno de
     * ellos. No es una defensa fuerte —un servidor puede mandar el Origin que
     * quiera— pero evita que la llave de un negocio quede incrustada en otra
     * web por descuido o copia.
     */
    if (apiKey.allowedOrigins.length) {
      const origin = (req.header('Origin') ?? '').replace(/\/$/, '');
      const ok = origin && apiKey.allowedOrigins.some((o) => o.replace(/\/$/, '') === origin);
      if (!ok) throw ApiError.forbidden('Este dominio no está autorizado para esta llave');
    }

    const tenant = await Tenant.findOne({ _id: apiKey.tenant, isActive: true }).lean();
    if (!tenant) throw ApiError.notFound('La tienda no está disponible');

    req.storefront = { tenant: tenant as ITenant, apiKeyId: apiKey._id.toString() };

    // Sirve para que el dueno vea cual de sus llaves sigue viva.
    void StoreApiKey.updateOne({ _id: apiKey._id }, { $set: { lastUsedAt: new Date() } }).catch(
      () => {},
    );

    next();
  },
);
