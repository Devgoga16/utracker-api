/**
 * Migrates WorkflowState.icon from emoji to icon-registry names.
 *
 *   npm run migrate:icons           # dry run, prints the plan
 *   npm run migrate:icons -- --apply
 *
 * Unrecognised values are reported and left untouched -- the UI falls back to a
 * neutral placeholder, so nothing breaks and nothing is silently destroyed.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { WorkflowState } from '../models/WorkflowState';
import '../models/Tenant'; // registers the schema used by the populate below

const EMOJI_TO_ICON: Record<string, string> = {
  '📥': 'inbox',
  '📦': 'package',
  '📤': 'package-open',
  '✅': 'circle-check',
  '✔': 'circle-check',
  '❌': 'circle-x',
  '✖': 'circle-x',
  '🏠': 'house',
  '🏪': 'store',
  '⏳': 'hourglass',
  '⏱': 'clock',
  '🕐': 'clock',
  '💸': 'coins',
  '💰': 'banknote',
  '💵': 'banknote',
  '💳': 'credit-card',
  '↩': 'undo-2',
  '🚗': 'car',
  '🚚': 'truck',
  '🛵': 'bike',
  '🚲': 'bike',
  '🔥': 'flame',
  '👨‍🍳': 'chef-hat',
  '🧾': 'receipt',
  '⚠': 'circle-alert',
  '🔔': 'bell',
  '🎁': 'gift',
};

/** Emoji often carry a U+FE0F variation selector; strip it before lookup. */
function normalise(value: string): string {
  return value.replace(/️/g, '').trim();
}

const VALID_NAME = /^[a-z0-9-]+$/;

async function main() {
  const apply = process.argv.includes('--apply');

  await mongoose.connect(env.mongodbUri);
  console.log(`[db] ${mongoose.connection.name}\n`);

  const states = await WorkflowState.find({}).populate('tenant', 'name');

  const planned: { id: string; tenant: string; state: string; from: string; to: string }[] = [];
  const unknown: { tenant: string; state: string; icon: string }[] = [];
  let alreadyOk = 0;

  for (const state of states) {
    const tenantName = (state.tenant as unknown as { name?: string })?.name ?? '(sin nombre)';
    const current = state.icon;

    if (!current) continue;

    if (VALID_NAME.test(current)) {
      alreadyOk++;
      continue;
    }

    const mapped = EMOJI_TO_ICON[normalise(current)];
    if (mapped) {
      planned.push({ id: state._id.toString(), tenant: tenantName, state: state.name, from: current, to: mapped });
    } else {
      unknown.push({ tenant: tenantName, state: state.name, icon: current });
    }
  }

  console.log(`Ya migrados : ${alreadyOk}`);
  console.log(`A migrar    : ${planned.length}`);
  console.log(`Sin mapear  : ${unknown.length}\n`);

  for (const p of planned) {
    console.log(`  [${p.tenant}] ${p.state.padEnd(18)} ${p.from}  ->  ${p.to}`);
  }

  if (unknown.length) {
    console.log('\nSin mapear (quedan como están, elegí un icono desde la UI):');
    for (const u of unknown) {
      console.log(`  [${u.tenant}] ${u.state.padEnd(18)} ${u.icon}`);
    }
  }

  if (!apply) {
    console.log('\nDry run. Volvé a correr con --apply para escribir los cambios.');
    await mongoose.disconnect();
    return;
  }

  if (planned.length) {
    await Promise.all(
      planned.map((p) => WorkflowState.updateOne({ _id: p.id }, { $set: { icon: p.to } })),
    );
  }

  console.log(`\nListo. ${planned.length} estado(s) actualizado(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[migration error]', err);
  process.exit(1);
});
