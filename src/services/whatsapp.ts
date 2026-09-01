const WA_BASE = process.env.WHATSAPP_API_URL ?? ''
const WA_KEY = process.env.WHATSAPP_API_KEY ?? ''

export async function sendWhatsappMessage(to: string, message: string): Promise<void> {
  if (!WA_BASE || !WA_KEY) return

  const number = to.replace(/\D/g, '')

  const res = await fetch(`${WA_BASE}/api/whatsapp/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': WA_KEY,
    },
    body: JSON.stringify({ to: number, message }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[WhatsApp] Error enviando a ${number}: ${res.status} ${body}`)
  }
}

interface OrderLine { name: string; quantity: number; unitPrice: number }

export function notifyOwnerNewOrder(opts: {
  ownerPhone: string
  customerName: string
  customerPhone: string
  items: OrderLine[]
  total: number
  source?: string   // 'campaña X', 'link de pedido', etc.
}): void {
  const { ownerPhone, customerName, customerPhone, items, total, source } = opts

  const lines = [
    `🛒 *Nuevo pedido${source ? ` — ${source}` : ''}*`,
    `Cliente: ${customerName} (${customerPhone})`,
    '',
    ...items.map((i) => `• ${i.name} x${i.quantity}  S/ ${(i.unitPrice * i.quantity).toFixed(2)}`),
    '',
    `*Total: S/ ${total.toFixed(2)}*`,
  ].join('\n')

  sendWhatsappMessage(ownerPhone, lines).catch(() => {})
}
