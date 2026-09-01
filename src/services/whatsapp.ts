import { env, isWhatsappConfigured } from '../config/env';

/** Solo advierte una vez por arranque: si no, ensucia el log en cada pedido. */
let warnedMissingConfig = false;

/**
 * Manda un mensaje por el bot de WhatsApp. Nunca lanza: una notificación que
 * falla no debe tumbar el cambio de estado ni el alta del pedido.
 */
export async function sendWhatsappMessage(to: string, message: string): Promise<void> {
  if (!isWhatsappConfigured()) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        '[WhatsApp] WHATSAPP_API_URL / WHATSAPP_API_KEY no configurados: no se enviarán notificaciones.',
      );
    }
    return;
  }

  // El bot espera solo dígitos y le pone el código de país si falta.
  const number = to.replace(/\D/g, '');
  if (!number) return;

  try {
    const res = await fetch(`${env.whatsapp.apiUrl}/api/whatsapp/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.whatsapp.apiKey!,
      },
      body: JSON.stringify({ to: number, message }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[WhatsApp] Error enviando a ${number}: ${res.status} ${body}`);
    }
  } catch (err) {
    // El bot puede estar caído o desconectado del celular: se registra y sigue.
    console.error(`[WhatsApp] No se pudo contactar al bot para ${number}:`, err);
  }
}

interface OrderLine {
  name: string;
  quantity: number;
  unitPrice: number;
}

/** Avisa al dueño que le entró un pedido desde un link público o una campaña. */
export function notifyOwnerNewOrder(opts: {
  ownerPhone: string;
  customerName: string;
  customerPhone: string;
  items: OrderLine[];
  total: number;
  source?: string; // 'campaña: X', 'link de pedido', etc.
}): void {
  const { ownerPhone, customerName, customerPhone, items, total, source } = opts;

  const lines = [
    `🛒 *Nuevo pedido${source ? ` — ${source}` : ''}*`,
    `Cliente: ${customerName} (${customerPhone})`,
    '',
    ...items.map((i) => `• ${i.name} x${i.quantity}  S/ ${(i.unitPrice * i.quantity).toFixed(2)}`),
    '',
    `*Total: S/ ${total.toFixed(2)}*`,
  ].join('\n');

  void sendWhatsappMessage(ownerPhone, lines);
}

/** Avisa al cliente que su pedido cambió de estado. */
export function notifyCustomerStateChange(opts: {
  customerPhone: string;
  customerName: string;
  stateName: string;
  trackingToken?: string;
}): void {
  const { customerPhone, customerName, stateName, trackingToken } = opts;

  const lines = [
    `Hola ${customerName}, tu pedido cambió de estado.`,
    `Estado: *${stateName}*`,
    trackingToken ? `\nSigue tu pedido aquí: ${env.frontendUrl}/track/${trackingToken}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  void sendWhatsappMessage(customerPhone, lines);
}
