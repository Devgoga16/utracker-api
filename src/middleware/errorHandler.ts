import { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ message: err.message });
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
  return res.status(500).json({ message: 'Internal server error' });
}
