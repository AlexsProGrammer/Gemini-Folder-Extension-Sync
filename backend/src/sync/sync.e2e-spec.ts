import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';

const TEST_DB_PATH = './data/e2e-sync.db';
const ACCOUNT_ID = 'a'.repeat(64);
const ALICE_ACCOUNT_ID = 'b'.repeat(64);

describe('Sync API (e2e)', () => {
  let app: NestFastifyApplication;
  let request: supertest.Agent;

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.API_KEY = 'test_secret_key_1234567890';
    process.env.API_KEY_ALICE = 'alice_test_key_1234567890';
    process.env.API_KEY_ALICE_ACCOUNTS = ALICE_ACCOUNT_ID;
    process.env.DB_PATH = TEST_DB_PATH;

    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ bodyLimit: 10485760 }));

    await app.register(helmet);
    await app.register(cors, { origin: true });

    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    request = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();

    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
    }
  });

  it('rejects requests without a valid bearer api key', async () => {
    await request.get(`/api/v1/sync/${ACCOUNT_ID}`).expect(401);
    await request.get(`/api/v1/sync/${ACCOUNT_ID}`).set({ Authorization: 'Bearer wrong-key' }).expect(401);
    await request.post(`/api/v1/sync/${ACCOUNT_ID}`).send({}).expect(401);
  });

  it('returns 404 on GET for an uninitialized account hash', async () => {
    await request.get(`/api/v1/sync/${ACCOUNT_ID}`).set(auth('test_secret_key_1234567890')).expect(404);
  });

  it('persists a POST payload with version 2', async () => {
    const response = await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 2, ciphertext: 'cipher-a', iv: 'iv-a', updatedAt: 1000 })
      .expect(201);

    expect(response.body).toEqual({ status: 'success', version: 2, updatedAt: 1000 });
  });

  it('returns the exact record on subsequent GET', async () => {
    const response = await request.get(`/api/v1/sync/${ACCOUNT_ID}`).set(auth('test_secret_key_1234567890')).expect(200);

    expect(response.body).toEqual({
      accountId: ACCOUNT_ID,
      version: 2,
      ciphertext: 'cipher-a',
      iv: 'iv-a',
      updatedAt: 1000
    });
  });

  it('rejects a stale POST with version 1 and returns 409 with serverState', async () => {
    const response = await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 1, ciphertext: 'cipher-stale', iv: 'iv-stale', updatedAt: 500 })
      .expect(409);

    expect(response.body.statusCode).toBe(409);
    expect(response.body.message).toBe('Version conflict detected');
    expect(response.body.serverState).toEqual({
      accountId: ACCOUNT_ID,
      version: 2,
      ciphertext: 'cipher-a',
      iv: 'iv-a',
      updatedAt: 1000
    });
  });

  it('rejects an API key that is not bound to the requested account', async () => {
    const response = await request.get(`/api/v1/sync/${ACCOUNT_ID}`).set(auth('alice_test_key_1234567890')).expect(403);

    expect(response.body.message).toBe('This API key is not authorized for this account.');
    await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('alice_test_key_1234567890'))
      .send({ version: 5, ciphertext: 'cipher-x', iv: 'iv-x', updatedAt: 5000 })
      .expect(403);
  });

  it('allows an API key to access only its bound accounts', async () => {
    const pushed = await request
      .post(`/api/v1/sync/${ALICE_ACCOUNT_ID}`)
      .set(auth('alice_test_key_1234567890'))
      .send({ version: 1, ciphertext: 'cipher-alice', iv: 'iv-alice', updatedAt: 2000 })
      .expect(201);

    expect(pushed.body).toEqual({ status: 'success', version: 1, updatedAt: 2000 });

    const fetched = await request.get(`/api/v1/sync/${ALICE_ACCOUNT_ID}`).set(auth('alice_test_key_1234567890')).expect(200);
    expect(fetched.body.ciphertext).toBe('cipher-alice');
  });

  it('lets the legacy key (all accounts) access another key\'s account', async () => {
    const response = await request.get(`/api/v1/sync/${ALICE_ACCOUNT_ID}`).set(auth('test_secret_key_1234567890')).expect(200);

    expect(response.body.ciphertext).toBe('cipher-alice');
  });
});