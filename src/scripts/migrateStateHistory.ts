/**
 * Backfills the frozen display data on existing stateHistory entries.
 *
 *   npm run migrate:history           # dry run, prints the plan
 *   npm run migrate:history -- --apply
 *
 * Old entries only referenced a WorkflowState. The best available approximation
 * of "what it was called back then" is what it is called now, so that is what we
 * copy in. Entries whose state no longer exists get a neutral placeholder rather
 * than being dropped -- losing a transition would be worse than an vague label.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { Order } from '../models/Order';
import { WorkflowState } from '../models/WorkflowState';

async function main() {
  const apply = process.argv.includes('--apply');

  await mongoose.connect(env.mongodbUri);
  console.log(`[db] ${mongoose.connection.name}\n`);

  const states = await WorkflowState.find({});
  const byId = new Map(states.map((s) => [s._id.toString(), s]));

  const orders = await Order.find({});

  let entriesFilled = 0;
  let entriesOrphaned = 0;
  let ordersTouched = 0;
  let alreadyOk = 0;

  for (const order of orders) {
    let changed = false;

    for (const entry of order.stateHistory) {
      if (entry.stateName) {
        alreadyOk++;
        continue;
      }

      const state = byId.get(entry.state?.toString() ?? '');
      if (state) {
        entry.stateName = state.name;
        entry.stateColor = state.color;
        entry.stateIcon = state.icon;
        entriesFilled++;
      } else {
        entry.stateName = 'Estado eliminado';
        entry.stateColor = '#64748b';
        entry.stateIcon = 'circle-dashed';
        entriesOrphaned++;
      }
      changed = true;
    }

    if (changed) {
      ordersTouched++;
      if (apply) await order.save();
    }
  }

  console.log(`Entradas ya migradas : ${alreadyOk}`);
  console.log(`Entradas a completar : ${entriesFilled}`);
  console.log(`Entradas huérfanas   : ${entriesOrphaned}  (estado ya no existe)`);
  console.log(`Pedidos afectados    : ${ordersTouched}`);

  if (!apply) {
    console.log('\nDry run. Volvé a correr con --apply para escribir los cambios.');
  } else {
    console.log('\nListo.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[migration error]', err);
  process.exit(1);
});
