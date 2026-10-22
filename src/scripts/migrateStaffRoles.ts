/**
 * Deja que el personal mueva pedidos en los negocios que ya existen.
 *
 * Los estados nacían permitidos solo para dueño y administrador: alguien
 * invitado como personal veía los pedidos pero no podía cambiarles el estado
 * hasta que el dueño lo habilitara uno por uno. Los negocios nuevos ya nacen
 * con el personal incluido; esto pone a los anteriores igual.
 *
 * Solo toca estados del pedido, y no el de cancelación: cancelar tiene su
 * propio botón y no depende de esta lista. No quita a nadie: si un dueño
 * había sacado al personal a propósito de algún estado, el personal vuelve a
 * tenerlo; por eso el reporte dice qué negocios cambiaron.
 *
 * Es idempotente: correrlo dos veces no cambia nada la segunda vez.
 *
 *   npm run migrate:staff-roles
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { WorkflowState } from '../models/WorkflowState';
import { Tenant } from '../models/Tenant';

async function main() {
  await mongoose.connect(env.mongodbUri);
  console.log('[migrate:staff-roles] conectado');

  const filter: Record<string, unknown> = {
    kind: 'fulfillment',
    isCancellation: { $ne: true },
    allowedRoles: { $ne: 'staff' },
  };

  const pending = await WorkflowState.find(filter).select('tenant').lean();
  if (!pending.length) {
    console.log('[migrate:staff-roles] nada que cambiar: el personal ya está en todos los estados');
    return;
  }

  const result = await WorkflowState.updateMany(filter, { $addToSet: { allowedRoles: 'staff' } });

  const tenantIds = [...new Set(pending.map((s) => String(s.tenant)))];
  const tenants = await Tenant.find({ _id: { $in: tenantIds } }).select('name').lean();
  const names = new Map(tenants.map((t) => [String(t._id), t.name]));

  console.log(
    `[migrate:staff-roles] listo: ${result.modifiedCount} estado(s) en ${tenantIds.length} negocio(s)`,
  );
  for (const id of tenantIds) {
    const count = pending.filter((s) => String(s.tenant) === id).length;
    console.log(`  · ${names.get(id) ?? '(negocio borrado)'} — ${count} estado(s)`);
  }
}

main()
  .catch((err) => {
    console.error('[migrate:staff-roles] falló', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
