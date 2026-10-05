import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import { isSharedBotConfigured, sendWhatsappOrThrow, sessionForTenant } from '../services/whatsapp';

/**
 * GET /superadmin/whatsapp/config
 *
 * Estado del bot COMPARTIDO. No consulta al bot: la sesion se administra por
 * fuera de uTracker y su API no expone estado ni QR. Lo unico que podemos
 * afirmar es si tenemos credenciales; si funcionan, lo dice el envio de prueba.
 */
export const whatsappConfig = asyncHandler(async (_req: Request, res: Response) => {
  const url = env.whatsapp.sendUrl ?? null;
  res.json({
    configured: isSharedBotConfigured(),
    // La URL lleva la sesion, no es secreta; la llave nunca sale.
    sendUrl: url,
    hasKey: Boolean(env.whatsapp.apiKey),
  });
});

// POST /superadmin/whatsapp/test  { to, message? }
export const whatsappTest = asyncHandler(async (req: Request, res: Response) => {
  const { to, message, tenantId } = req.body as {
    to?: string;
    message?: string;
    /** Para probar la sesion propia de un negocio; sin esto, la compartida. */
    tenantId?: string;
  };

  const number = to?.replace(/\D/g, '') ?? '';
  if (!number) throw ApiError.badRequest('Indica el número de destino.');
  if (number.length < 8 || number.length > 15) {
    throw ApiError.badRequest('El número debe tener entre 8 y 15 dígitos.');
  }

  const text = message?.trim() || 'Mensaje de prueba desde uTracker. Si lo lees, todo funciona.';

  try {
    const session = tenantId ? await sessionForTenant(tenantId) : undefined;
    await sendWhatsappOrThrow(number, text, session);
  } catch (err) {
    throw ApiError.badGateway(
      err instanceof Error ? err.message : 'No se pudo enviar el mensaje.',
    );
  }

  res.json({ ok: true, to: number });
});
