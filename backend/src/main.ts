import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { config as loadEnv } from 'dotenv';
import { AppModule } from './app.module';

loadEnv();

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    bodyLimit: 10485760,
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
  await app.register(cors, { origin: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true
    })
  );

  const port = Number(process.env.PORT) || 3000;

  await app.listen(port, '0.0.0.0');
}

void bootstrap();