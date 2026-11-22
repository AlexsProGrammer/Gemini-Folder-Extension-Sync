import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { config as loadEnv } from 'dotenv';
import { AppModule } from './app.module';

loadEnv();

function parseTrustProxy(raw: string | undefined): boolean | string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return '127.0.0.1';
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  return trimmed;
}

function parseCorsOrigin(raw: string | undefined): boolean | string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return false;
  }
  const origins = trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : false;
}

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    bodyLimit: 10485760,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.remoteAddress'],
        remove: true
      }
    }
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  await app.register(helmet);
  await app.register(cors, { origin: parseCorsOrigin(process.env.CORS_ORIGINS) });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true
    })
  );

  const port = Number(process.env.PORT) || 3350;

  await app.listen(port, '0.0.0.0');
}

void bootstrap();