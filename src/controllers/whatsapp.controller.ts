import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { getWhatsappStatus, sendWhatsappOrThrow } from '../services/whatsapp';

// GET /superadmin/whatsapp/status
export const whatsappStatus = asyncHandler(async (_req: Request, res: Response) => {
  try {
    const data = await getWhatsappStatus();
    res.json({ data });
  } catch (err) {
    // El bot caído no es un 500 nuestro: es una dependencia externa fuera de servicio.
    throw ApiError.badGateway(
      err instanceof Error ? err.message : 'No se pudo contactar al bot de WhatsApp.',
    );
  }
});

// POST /superadmin/whatsapp/test  { to, message? }
export const whatsappTest = asyncHandler(async (req: Request, res: Response) => {
  const { to, message } = req.body as { to?: string; message?: string };

  const number = to?.replace(/\D/g, '') ?? '';
  if (!number) throw ApiError.badRequest('Indica el número de destino.');
  if (number.length < 8 || number.length > 15) {
    throw ApiError.badRequest('El número debe tener entre 8 y 15 dígitos.');
  }

  const text = message?.trim() || 'Mensaje de prueba desde uTracker. Si lo lees, todo funciona.';

  try {
    await sendWhatsappOrThrow(number, text);
  } catch (err) {
    throw ApiError.badGateway(
      err instanceof Error ? err.message : 'No se pudo enviar el mensaje.',
    );
  }

  res.json({ ok: true, to: number });
});
