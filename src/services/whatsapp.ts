import { env } from '../config/env';
import { Tenant } from '../models/Tenant';

/** Solo advierte una vez por arranque: si no, ensucia el log en cada pedido. */
let warnedMissingConfig = false;

/**
 * Corte duro para el bot.
 *
 * Se midio en produccion que un envio puede quedarse colgado en vez de fallar
 * rapido. Sin este corte, una notificacion lenta deja esperando a quien hizo
 * el pedido, que es justo lo que no debe pasar con un aviso secundario.
 */
const SEND_TIMEOUT_MS = 12_000;

/**
 * Codigo de pais que se antepone a los numeros locales.
 *
 * Configurable porque uTracker no es solo de Peru, pero con 51 por defecto:
 * es de donde son hoy todos los negocios.
 */
const COUNTRY_CODE = process.env.WHATSAPP_COUNTRY_CODE?.replace(/\D/g, '') || '51';

/** Largo de un celular peruano sin codigo de pais. */
const LOCAL_LENGTH = 9;

/**
 * Deja el numero como lo espera el bot: solo digitos y con codigo de pais.
 *
 * Los clientes escriben su celular como lo dicen —"987 654 321"— y asi se
 * guarda. Normalizar al enviar, y no al guardar, arregla de una vez todos los
 * numeros que ya estan en la base sin tener que migrarlos.
 */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '');

  // "0" inicial de marcacion nacional: no va en formato internacional.
  if (digits.length === LOCAL_LENGTH + 1 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Un celular local pelado necesita el codigo de pais para que el bot resuelva.
  if (digits.length === LOCAL_LENGTH) return `${COUNTRY_CODE}${digits}`;

  // Cualquier otro largo ya trae su codigo (propio o extranjero): no se toca.
  return digits;
}

/**
 * A que sesion de WhatsApp mandar.
 *
 * Cada negocio puede tener la suya —manda desde su propio numero, cuesta mas—
 * o caer al bot compartido de uTracker. Lo elige el superadmin por negocio.
 */
export interface WhatsappSession {
  sendUrl: string;
  apiKey: string;
}

/** La sesion propia del negocio, o la compartida, o nada. */
export function resolveSession(tenant?: {
  whatsapp?: { sendUrl?: string; apiKey?: string } | null;
} | null): WhatsappSession | null {
  const own = tenant?.whatsapp;
  if (own?.sendUrl && own?.apiKey) {
    return { sendUrl: own.sendUrl, apiKey: own.apiKey };
  }
  if (env.whatsapp.sendUrl && env.whatsapp.apiKey) {
    return { sendUrl: env.whatsapp.sendUrl, apiKey: env.whatsapp.apiKey };
  }
  return null;
}

/**
 * Carga la sesion de un negocio por id.
 *
 * Hace falta porque `whatsapp` esta marcado `select: false` en el modelo: no
 * viaja en las consultas normales justamente para que la apiKey no se escape
 * por una respuesta cualquiera.
 */
export async function sessionForTenant(tenantId: unknown): Promise<WhatsappSession | null> {
  const tenant = await Tenant.findById(tenantId).select('+whatsapp').lean();
  return resolveSession(tenant as { whatsapp?: { sendUrl?: string; apiKey?: string } } | null);
}

/**
 * Envia de verdad y lanza si algo falla. Lo usan el envio best-effort y el
 * boton de prueba del panel, que si necesita ver el error.
 */
export async function sendWhatsappOrThrow(
  to: string,
  message: string,
  session?: WhatsappSession | null,
): Promise<void> {
  const target = session ?? resolveSession(null);
  if (!target) {
    throw new Error('No hay una sesión de WhatsApp configurada para este negocio.');
  }

  const number = normalizePhone(to);
  if (!number) throw new Error('El número de destino está vacío.');

  let res: Response;
  try {
    res = await fetch(target.sendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({ to: number, text: message }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('El bot de WhatsApp no respondió a tiempo.');
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`El bot respondió ${res.status}. ${body}`.trim());
  }
}

/**
 * Manda un mensaje. Nunca lanza: una notificación que falla no debe tumbar el
 * cambio de estado ni el alta del pedido.
 */
export async function sendWhatsappMessage(
  to: string,
  message: string,
  session?: WhatsappSession | null,
): Promise<void> {
  const target = session ?? resolveSession(null);
  if (!target) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        '[WhatsApp] Sin sesión configurada (WHATSAPP_SEND_URL / WHATSAPP_API_KEY): no se enviarán notificaciones.',
      );
    }
    return;
  }

  try {
    await sendWhatsappOrThrow(to, message, target);
  } catch (err) {
    // El bot puede estar caído o desconectado del celular: se registra y sigue.
    console.error(`[WhatsApp] No se pudo enviar a ${to}:`, err);
  }
}

/** Si el bot compartido de uTracker tiene URL y llave. */
export function isSharedBotConfigured(): boolean {
  return Boolean(env.whatsapp.sendUrl && env.whatsapp.apiKey);
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
  session?: WhatsappSession | null;
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

  void sendWhatsappMessage(ownerPhone, lines, opts.session);
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
  scheduledFor?: { date: string; franja?: string };
  /** 'campaña: Helados' o similar, para ubicar al cliente. */
  source?: string;
  session?: WhatsappSession | null;
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
    const franja = scheduledFor.franja
      ? ` · ${FRANJA_LABEL[scheduledFor.franja] ?? scheduledFor.franja}`
      : '';
    parts.push(`🗓 ${spanishDate(scheduledFor.date)}${franja}`);
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
  session?: WhatsappSession | null;
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
  session?: WhatsappSession | null;
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
  session?: WhatsappSession | null;
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
