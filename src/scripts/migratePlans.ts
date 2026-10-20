/**
 * Pone al día los planes que ya existen en la base.
 *
 * Hace dos cosas:
 *
 * 1. Rellena `code`, `sortOrder` e `isPublic`, que antes no existían.
 *
 * 2. Enciende en los planes viejos las funcionalidades nuevas del catálogo.
 *    Esto es lo importante: campañas, tienda pública, filtros y los avisos por
 *    WhatsApp funcionaban para todos porque nadie los bloqueaba. Si quedaran
 *    apagados por defecto, al desplegar esto cada negocio perdería de golpe
 *    algo que venía usando. Se encienden aquí y desde la pantalla de planes se
 *    apagan a conciencia, plan por plan.
 *
 * Es idempotente: correrlo dos veces no cambia nada la segunda vez.
 *
 *   npm run migrate:plans
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { Plan, planCodeFromName } from '../models/Plan';
import { FLAG_KEYS, LIMIT_KEYS } from '../config/features.catalog';
import { Subscription } from '../models/Subscription';
// Registra el modelo: el reporte final hace populate('tenant').
import '../models/Tenant';

async function main() {
  await mongoose.connect(env.mongodbUri);
  console.log('[migrate:plans] conectado');

  const plans = await Plan.find().sort({ price: 1 });
  if (!plans.length) {
    console.log('[migrate:plans] no hay planes; nada que migrar');
    return;
  }

  const usedCodes = new Set(plans.map((p) => p.code).filter(Boolean) as string[]);
  let changed = 0;

  for (const [index, plan] of plans.entries()) {
    const before = JSON.stringify({
      code: plan.code,
      sortOrder: plan.sortOrder,
      isPublic: plan.isPublic,
      features: plan.features,
    });

    /*
     * Un plan sin código es anterior al catálogo: ahí, que falte una
     * funcionalidad significa que todavía no existía, no que esté excluida.
     * Uno con código ya fue creado con el catálogo, y lo que le falta lo
     * excluye a propósito. Confundirlos encendía de más los planes sembrados.
     */
    const legacy = !plan.code;

    if (!plan.code) {
      let code = planCodeFromName(plan.name);
      let suffix = 2;
      while (usedCodes.has(code)) code = `${planCodeFromName(plan.name)}-${suffix++}`;
      usedCodes.add(code);
      plan.code = code;
    }

    /*
     * `$isDefault` y no `=== undefined`: Mongoose rellena los campos que faltan
     * con su valor por defecto al leer el documento, así que un campo ausente
     * en la base nunca se ve vacío. Comparar con undefined no detectaba nada y
     * el plan viejo quedaba publicado con el `isPublic: true` del schema.
     */
    if (plan.$isDefault('sortOrder')) plan.sortOrder = index + 1;
    /*
     * Oculto, no público. Antes no existía la página de precios: publicar un
     * plan viejo sería ponerlo en la web sin que nadie lo haya decidido (y
     * suele ser uno gratis armado para pruebas). Se publica desde Planes.
     */
    if (plan.$isDefault('isPublic')) plan.isPublic = false;

    const features: Record<string, unknown> = { ...(plan.features ?? {}) };

    // En un plan antiguo, lo que falta se enciende: sus negocios ya lo usaban.
    // En uno nuevo, lo que falta queda apagado y explícito. Lo ya definido no
    // se toca en ningún caso.
    for (const key of FLAG_KEYS) {
      if (features[key] === undefined || features[key] === null) features[key] = legacy;
    }
    // Los límites nuevos quedan en 0 = ilimitado, que es como estaban de hecho.
    for (const key of LIMIT_KEYS) {
      if (features[key] === undefined || features[key] === null) features[key] = 0;
    }

    plan.features = features;
    plan.markModified('features');

    const after = JSON.stringify({
      code: plan.code,
      sortOrder: plan.sortOrder,
      isPublic: plan.isPublic,
      features: plan.features,
    });

    if (before !== after) {
      await plan.save();
      changed += 1;
      console.log(`[migrate:plans] "${plan.name}" → código "${plan.code}", funcionalidades al día`);
    }
  }

  console.log(
    `[migrate:plans] listo: ${changed} de ${plans.length} plan(es) actualizados`,
  );

  await reportExpiredSubscriptions();
}

/**
 * Avisa qué negocios quedan en solo lectura por tener la fecha vencida.
 *
 * Hasta ahora `expiresAt` no hacía nada: solo bloqueaba el estado
 * 'suspended'. Desde este cambio manda la fecha, así que una fecha vieja
 * puesta en una prueba deja al negocio sin poder registrar nada. Mejor
 * enterarse aquí que por un reclamo.
 */
async function reportExpiredSubscriptions() {
  const expired = await Subscription.find({
    status: { $ne: 'suspended' },
    expiresAt: { $ne: null, $lt: new Date() },
  })
    .populate<{ tenant: { name?: string } }>('tenant', 'name')
    .select('tenant status expiresAt')
    .lean();

  if (!expired.length) {
    console.log('[migrate:plans] ninguna suscripción vencida: nadie queda en solo lectura');
    return;
  }

  console.log('');
  console.log(
    `[migrate:plans] ATENCIÓN: ${expired.length} suscripción(es) con fecha pasada.`,
  );
  console.log('Desde ahora cuentan como vencidas y esos negocios no van a poder registrar nada.');
  console.log('Si la fecha era de una prueba, corrígela desde Superadmin → Negocios.');
  console.log('');
  for (const sub of expired) {
    const name = (sub.tenant as { name?: string } | null)?.name ?? '(negocio borrado)';
    console.log(`  · ${name} — vencía ${sub.expiresAt?.toISOString().slice(0, 10)}`);
  }
}

main()
  .catch((err) => {
    console.error('[migrate:plans] falló', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
