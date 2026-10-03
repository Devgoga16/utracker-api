/**
 * Código corto y legible del pedido, para que cliente y negocio hablen del
 * mismo: "mi pedido A3F9C2".
 *
 * Se deriva del trackingToken en vez de ser un correlativo propio: así vale
 * para los pedidos que ya existen sin migrar nada, no hay contador que pueda
 * duplicarse entre pedidos simultáneos, y sigue siendo único porque el token
 * es un hex de 32 caracteres.
 *
 * No sirve para adivinar el enlace de seguimiento: son solo los últimos 6 de
 * 32, conocerlo no permite reconstruir el resto.
 */
export function orderCode(trackingToken: string): string {
  return trackingToken.slice(-6).toUpperCase();
}
