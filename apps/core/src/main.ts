import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  const port = Number(process.env.AISTAFF_PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[aistaff-core] listening on http://127.0.0.1:${port}`);
}

void bootstrap();
