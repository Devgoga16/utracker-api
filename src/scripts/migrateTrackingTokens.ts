/**
 * Backfills trackingToken on orders created before the tracking page existed.
 *
 *   npm run migrate:tracking           # dry run
 *   npm run migrate:tracking -- --apply
 */
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { Order } from '../models/Order';

async function main() {
  const apply = process.argv.includes('--apply');

  await mongoose.connect(env.mongodbUri);
  console.log(`[db] ${mongoose.connection.name}\n`);

  const pending = await Order.find({
    $or: [{ trackingToken: { $exists: false } }, { trackingToken: null }],
  });

  console.log(`Pedidos sin token: ${pending.length}`);

  if (apply) {
    for (const order of pending) {
      await Order.updateOne(
        { _id: order._id },
        { $set: { trackingToken: randomBytes(16).toString('hex') } }
      );
    }
    console.log(`\nListo. ${pending.length} token(s) generado(s).`);
  } else {
    console.log('\nDry run. Volvé a correr con --apply para escribir los cambios.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[migration error]', err);
  process.exit(1);
});
