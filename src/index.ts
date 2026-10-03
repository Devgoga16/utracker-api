import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env, isOriginAllowed } from './config/env';
import { connectDB } from './config/db';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { router } from './routes';

async function main() {
  await connectDB();

  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Sin cabecera Origin no hay navegador de por medio (curl, el propio
        // servidor, health checks): esos no los restringe CORS.
        if (!origin) return callback(null, true);
        callback(null, isOriginAllowed(origin));
      },
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  app.listen(env.port, () => {
    console.log(`[server] listening on port ${env.port}`);
  });
}

main().catch((err) => {
  console.error('[startup error]', err);
  process.exit(1);
});
