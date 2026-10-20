import { env, isEmailConfigured } from '../config/env';
import { logEvent } from './systemLog';

/**
 * Envío de correo por Resend, con `fetch` y sin SDK.
 *
 * Misma disciplina que el servicio de WhatsApp: timeout propio, una variante
 * que lanza para cuando el llamador necesita ver el error, y otra que no lanza
 * nunca para los avisos — que un correo no salga no debe tumbar la operación
 * que lo disparó.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Resend responde rápido; si no, algo está mal y conviene cortar. */
const SEND_TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  /** Alternativa en texto plano. Sin esto, varios clientes marcan spam. */
  text: string;
}

let warnedMissingConfig = false;

/** Manda el correo y lanza si falla. */
export async function sendEmailOrThrow(message: EmailMessage): Promise<string> {
  if (!isEmailConfigured()) {
    throw new Error('Resend no está configurado (RESEND_API_KEY / RESEND_FROM).');
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.resend.from,
      to: Array.isArray(message.to) ? message.to : [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(env.resend.replyTo ? { reply_to: env.resend.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  const body = (await response.json().catch(() => null)) as
    | { id?: string; message?: string; name?: string }
    | null;

  if (!response.ok) {
    // El mensaje de Resend es específico y vale más que un "falló el envío".
    throw new Error(body?.message ?? `Resend respondió ${response.status}`);
  }

  return body?.id ?? '';
}

/**
 * Manda el correo sin lanzar. Devuelve si salió.
 *
 * Deja el fallo en los logs del sistema con su código de referencia, así que
 * un correo que no llegó se puede rastrear desde el visor en vez de quedar
 * solo en la consola del servidor.
 */
export async function sendEmail(
  message: EmailMessage,
  context?: { tenant?: string; action?: string },
): Promise<boolean> {
  if (!isEmailConfigured()) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        '[email] Sin configurar (RESEND_API_KEY / RESEND_FROM): no se enviarán correos.',
      );
    }
    return false;
  }

  try {
    await sendEmailOrThrow(message);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[email] no se pudo enviar:', reason);

    logEvent({
      level: 'warn',
      source: 'api',
      message: `No se pudo enviar el correo "${message.subject}": ${reason}`,
      action: context?.action ?? 'email:send',
      tenant: context?.tenant,
      context: { to: message.to },
    });

    return false;
  }
}

/* ─────────────────────── Plantilla ─────────────────────── */

/**
 * Envoltura común de los correos.
 *
 * Tablas y estilos en línea porque los clientes de correo no entienden flex ni
 * hojas externas, y Gmail descarta `<style>` en varios casos.
 */
function layout(opts: { heading: string; body: string; footer?: string }): string {
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e2e8f0;">
    <tr><td style="padding:28px 28px 0;">
      <p style="margin:0 0 18px;font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#0f172a;">uTracker</p>
      <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;font-weight:700;color:#0f172a;">${opts.heading}</h1>
    </td></tr>
    <tr><td style="padding:0 28px 24px;font-size:14px;line-height:1.6;color:#475569;">${opts.body}</td></tr>
    <tr><td style="padding:16px 28px 24px;border-top:1px solid #f1f5f9;font-size:12px;line-height:1.5;color:#94a3b8;">
      ${opts.footer ?? 'Si no esperabas este correo, puedes ignorarlo.'}
    </td></tr>
  </table>
</body>
</html>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
  <tr><td style="border-radius:9px;background:#0f172a;">
    <a href="${url}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${label}</a>
  </td></tr>
</table>`;
}

const ROLE_WORDING: Record<string, string> = {
  owner: 'dueño, con acceso total',
  admin: 'administrador, con acceso a casi todo',
  staff: 'parte del personal',
  driver: 'repartidor',
};

/** Invitación a sumarse al equipo de un negocio. */
export function invitationEmail(opts: {
  businessName: string;
  inviterName?: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
  /** La persona todavía no tiene cuenta en uTracker. */
  needsAccount: boolean;
}): EmailMessage {
  const roleText = ROLE_WORDING[opts.role] ?? opts.role;
  const expires = opts.expiresAt.toLocaleDateString('es-PE', {
    day: 'numeric',
    month: 'long',
  });
  const who = opts.inviterName ? `${opts.inviterName} te` : 'Te';

  const next = opts.needsAccount
    ? 'Al abrir el enlace vas a elegir tu contraseña y entrar directo.'
    : 'Al abrir el enlace te pedimos tu contraseña de uTracker y listo.';

  const html = layout({
    heading: `${who} invitó a trabajar en ${opts.businessName}`,
    body: `
      <p style="margin:0 0 12px;">Vas a entrar como <strong>${roleText}</strong>.</p>
      <p style="margin:0;">${next}</p>
      ${button(opts.acceptUrl, 'Aceptar la invitación')}
      <p style="margin:0;font-size:13px;color:#64748b;">
        O copia este enlace:<br>
        <span style="word-break:break-all;color:#475569;">${opts.acceptUrl}</span>
      </p>`,
    footer: `La invitación vence el ${expires}. Si no esperabas este correo, puedes ignorarlo: no se crea ninguna cuenta hasta que abras el enlace.`,
  });

  const text = [
    `${who} invitó a trabajar en ${opts.businessName} desde uTracker.`,
    `Vas a entrar como ${roleText}.`,
    '',
    'Acepta la invitación aquí:',
    opts.acceptUrl,
    '',
    `La invitación vence el ${expires}.`,
  ].join('\n');

  return { to: '', subject: `Te invitaron a ${opts.businessName} en uTracker`, html, text };
}
