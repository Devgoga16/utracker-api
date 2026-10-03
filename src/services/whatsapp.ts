import { env, isWhatsappConfigured } from '../config/env';

/** Solo advierte una vez por arranque: si no, ensucia el log en cada pedido. */
let warnedMissingConfig = false;

/**
 * Envia de verdad y lanza si algo falla. Lo usan el envio best-effort y el
 * boton de prueba del panel, que si necesita ver el error.
 */
export async function sendWhatsappOrThrow(to: string, message: string): Promise<void> {
  if (!isWhatsappConfigured()) {
    throw new Error('El bot de WhatsApp no está configurado en el servidor.');
  }

  // El bot espera solo dígitos y le pone el código de país si falta.
  const number = to.replace(/\D/g, '');
  if (!number) throw new Error('El número de destino está vacío.');

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
    throw new Error(`El bot respondió ${res.status}. ${body}`.trim());
  }
}

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

  try {
    await sendWhatsappOrThrow(to, message);
  } catch (err) {
    // El bot puede estar caído o desconectado del celular: se registra y sigue.
    console.error(`[WhatsApp] No se pudo enviar a ${to}:`, err);
  }
}

export type WaStatus = 'connected' | 'open' | 'connecting' | 'reconnecting' | 'close' | 'qr';

export interface WaStatusResult {
  status: WaStatus;
  connected: boolean;
  /** data:image/png;base64,… mientras el bot espera que escaneen el QR. */
  qr?: string | null;
  phone?: { number: string; name: string };
  /** false cuando faltan las variables de entorno del bot. */
  configured: boolean;
}

/**
 * Estado del bot, para la pantalla de superadmin.
 *
 * Vive en el servidor a proposito: la API key no puede viajar al navegador,
 * y de paso el llamado es servidor a servidor, sin CORS de por medio.
 */
export async function getWhatsappStatus(): Promise<WaStatusResult> {
  if (!isWhatsappConfigured()) {
    return { status: 'close', connected: false, qr: null, configured: false };
  }

  const res = await fetch(`${env.whatsapp.apiUrl}/api/whatsapp/status`, {
    headers: { accept: 'application/json', 'x-api-key': env.whatsapp.apiKey! },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`El bot respondio ${res.status}. ${body}`.trim());
  }

  const json = (await res.json()) as { data?: Partial<WaStatusResult> };
  const data = json.data ?? {};

  return {
    status: (data.status as WaStatus) ?? 'close',
    connected: Boolean(data.connected),
    qr: data.qr ?? null,
    phone: data.phone,
    configured: true,
  };
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

const FRANJA_LABEL: Record<string, string> = {
  morning: 'Mañana',
  afternoon: 'Tarde',
  evening: 'Noche',
};

/** "2026-10-05" -> "sábado 5 de octubre", sin corrimiento de zona horaria. */
function spanishDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-PE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

/**
 * Comprobante de compra para el cliente, apenas confirma el pedido.
 *
 * Es su única constancia: el negocio ve el pedido en el panel, pero el cliente
 * solo tiene este mensaje y el link de seguimiento.
 */
export function notifyCustomerNewOrder(opts: {
  customerPhone: string;
  customerName: string;
  businessName: string;
  items: OrderLine[];
  total: number;
  trackingToken?: string;
  /** Adelanto que dejó pagado, si el pedido lo pedía. */
  advance?: { amount: number; validated: boolean };
  delivery?: { type: string; address?: string };
  scheduledFor?: { date: string; franja: string };
  /** 'campaña: Helados' o similar, para ubicar al cliente. */
  source?: string;
}): void {
  const {
    customerPhone,
    customerName,
    businessName,
    items,
    total,
    trackingToken,
    advance,
    delivery,
    scheduledFor,
    source,
  } = opts;

  const parts: string[] = [
    `¡Gracias por tu compra, ${customerName}! 🎉`,
    '',
    `*Tu pedido en ${businessName}*${source ? `\n_${source}_` : ''}`,
    '',
    ...items.map((i) => `• ${i.name} x${i.quantity}   S/ ${(i.unitPrice * i.quantity).toFixed(2)}`),
    '',
    `*Total: S/ ${total.toFixed(2)}*`,
  ];

  if (advance && advance.amount > 0) {
    parts.push(
      advance.validated
        ? `Adelanto pagado: S/ ${advance.amount.toFixed(2)}`
        : `Adelanto enviado: S/ ${advance.amount.toFixed(2)} _(pendiente de confirmación)_`,
    );
  }

  if (delivery) {
    parts.push('');
    parts.push(
      delivery.type === 'pickup'
        ? '📍 Recojo en tienda'
        : `🚚 Delivery a: ${delivery.address ?? 'la dirección que indicaste'}`,
    );
  }

  if (scheduledFor?.date) {
    const franja = FRANJA_LABEL[scheduledFor.franja] ?? scheduledFor.franja;
    parts.push(`🗓 ${spanishDate(scheduledFor.date)} · ${franja}`);
  }

  if (trackingToken) {
    parts.push('');
    parts.push(`Sigue tu pedido acá:\n${env.frontendUrl}/track/${trackingToken}`);
  }

  void sendWhatsappMessage(customerPhone, parts.join('\n'));
}

/** Le confirma al cliente que su pago fue revisado y aceptado. */
export function notifyCustomerPaymentValidated(opts: {
  customerPhone: string;
  customerName: string;
  businessName: string;
  amount: number;
  orderCode: string;
  trackingToken?: string;
}): void {
  const { customerPhone, customerName, businessName, amount, orderCode, trackingToken } = opts;

  const lines = [
    `✅ ¡Listo, ${customerName}!`,
    '',
    `${businessName} confirmó tu pago de *S/ ${amount.toFixed(2)}*.`,
    `Pedido *${orderCode}*`,
    '',
    'Ya estamos con tu pedido.',
    trackingToken ? `\nSíguelo acá:\n${env.frontendUrl}/track/${trackingToken}` : '',
  ].filter(Boolean);

  void sendWhatsappMessage(customerPhone, lines.join('\n'));
}

/**
 * Le avisa al cliente que su comprobante no pudo validarse.
 *
 * El mensaje no acusa: casi siempre es una captura borrosa o un depósito que
 * aún no figura. Lo manda al seguimiento, donde hay un botón que abre el chat
 * con el negocio y le permite reenviar el voucher.
 */
export function notifyCustomerPaymentRejected(opts: {
  customerPhone: string;
  customerName: string;
  businessName: string;
  amount: number;
  orderCode: string;
  trackingToken?: string;
}): void {
  const { customerPhone, customerName, businessName, amount, orderCode, trackingToken } = opts;

  const lines = [
    `Hola ${customerName}, sobre tu pedido *${orderCode}*:`,
    '',
    `${businessName} no pudo confirmar el pago de *S/ ${amount.toFixed(
      2,
    )}*. Puede ser que la imagen no se vea bien o que el depósito aún no figure.`,
    '',
    trackingToken
      ? `Entra a tu seguimiento y toca *"Regularizar mi pago"*: te abre el chat con la tienda para que mandes el voucher.\n\n${env.frontendUrl}/track/${trackingToken}`
      : 'Escríbenos para regularizarlo.',
  ].filter(Boolean);

  void sendWhatsappMessage(customerPhone, lines.join('\n'));
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
