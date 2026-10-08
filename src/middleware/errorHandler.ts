import { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logEvent } from '../services/systemLog';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

/**
 * Guarda el error en el visor de logs y devuelve el código con el que el
 * usuario puede reportarlo.
 *
 * Solo se registran los 5xx: los 4xx son el sistema funcionando —validaciones,
 * permisos, cosas que el usuario corrige solo— y llenarían el visor de ruido
 * hasta volverlo inservible justo cuando hace falta buscar algo real.
 */
function recordServerError(err: unknown, req: Request, statusCode: number): string | undefined {
  if (statusCode < 500) return undefined;

  return logEvent({
    level: 'error',
    source: 'api',
    statusCode,
    message: err instanceof Error ? err.message : String(err),
    action: `${req.method} ${req.originalUrl}`,
    stack: err instanceof Error ? err.stack : undefined,
    tenant: req.auth?.tenantId,
    user: req.auth?.userId,
    context: {
      body: req.body,
      query: req.query,
      params: req.params,
      support: req.auth?.support ? true : undefined,
    },
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    const ref = recordServerError(err, req, err.statusCode);
    return res.status(err.statusCode).json({ message: err.message, ref });
  }

  if (err instanceof Error && err.name === 'ValidationError') {
    return res.status(400).json({ message: err.message });
  }

  // Multer rejects oversized uploads before the controller runs.
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = (env.r2.maxUploadBytes / 1024 / 1024).toFixed(1);
      return res.status(413).json({ message: `La imagen supera el máximo de ${mb} MB` });
    }
    return res.status(400).json({ message: `Error al subir el archivo: ${err.code}` });
  }

  console.error('[unhandled error]', err);
  const ref = recordServerError(err, req, 500);
  return res.status(500).json({
    message: ref
      ? `Ocurrió un error inesperado. Código de referencia: ${ref}`
      : 'Internal server error',
    ref,
  });
}
