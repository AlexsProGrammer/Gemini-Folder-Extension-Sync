import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { parseTrustProxy } from '../main';

const TEST_DB_PATH = join(tmpdir(), `gemini-sync-e2e-${process.pid}.db`);
const ACCOUNT_ID = 'a'.repeat(64);
const ALICE_ACCOUNT_ID = 'b'.repeat(64);
const CIPHER_A = Buffer.from('cipher-a').toString('base64');
const IV_A = Buffer.from('iv-a').toString('base64');
const CIPHER_STALE = Buffer.from('cipher-stale').toString('base64');
const IV_STALE = Buffer.from('iv-stale').toString('base64');
const CIPHER_X = Buffer.from('cipher-x').toString('base64');
const IV_X = Buffer.from('iv-x').toString('base64');
const CIPHER_ALICE = Buffer.from('cipher-alice').toString('base64');
const IV_ALICE = Buffer.from('iv-alice').toString('base64');

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

  it('persists a POST payload with version 2 and returns matching ETag', async () => {
    const response = await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 2, ciphertext: CIPHER_A, iv: IV_A, updatedAt: 1000 })
      .expect(201);

    expect(response.headers.etag).toBe('"v2-1000"');
    expect(response.body).toEqual({ status: 'success', version: 2, updatedAt: 1000 });
  });

  it('returns the exact record and ETag on subsequent GET', async () => {
    const response = await request.get(`/api/v1/sync/${ACCOUNT_ID}`).set(auth('test_secret_key_1234567890')).expect(200);

    expect(response.headers.etag).toBe('"v2-1000"');
    expect(response.body).toEqual({
      accountId: ACCOUNT_ID,
      version: 2,
      ciphertext: CIPHER_A,
      iv: IV_A,
      updatedAt: 1000
    });
  });

  it('returns 304 Not Modified when If-None-Match matches ETag', async () => {
    const response = await request
      .get(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .set('If-None-Match', '"v2-1000"')
      .expect(304);

    expect(response.headers.etag).toBe('"v2-1000"');
    expect(response.text).toBe('');
  });

  it('rejects a stale POST with version 1 and returns 409 with serverState', async () => {
    const response = await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 1, ciphertext: CIPHER_STALE, iv: IV_STALE, updatedAt: 500 })
      .expect(409);

    expect(response.body.statusCode).toBe(409);
    expect(response.body.message).toBe('Version conflict detected');
    expect(response.body.serverState).toEqual({
      accountId: ACCOUNT_ID,
      version: 2,
      ciphertext: CIPHER_A,
      iv: IV_A,
      updatedAt: 1000
    });
  });

  it('rejects concurrent baseVersion mismatches including equal-version N+1 and higher-version N+2', async () => {
    const equalVersionConflict = await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 2, baseVersion: 1, ciphertext: CIPHER_STALE, iv: IV_STALE, updatedAt: 1100 })
      .expect(409);

    expect(equalVersionConflict.body.serverState.version).toBe(2);

    const branchedConflict = await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 3, baseVersion: 1, ciphertext: CIPHER_STALE, iv: IV_STALE, updatedAt: 1200 })
      .expect(409);

    expect(branchedConflict.body.serverState.version).toBe(2);

    const nonAdvancingConflict = await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 2, baseVersion: 2, ciphertext: CIPHER_STALE, iv: IV_STALE, updatedAt: 1250 })
      .expect(409);

    expect(nonAdvancingConflict.body.serverState.version).toBe(2);

    const validAdvance = await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 3, baseVersion: 2, ciphertext: CIPHER_A, iv: IV_A, updatedAt: 1300 })
      .expect(201);

    expect(validAdvance.body).toEqual({ status: 'success', version: 3, updatedAt: 1300 });
  });

  it('returns 400 Bad Request on invalid Base64 or oversized iv', async () => {
    await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 4, baseVersion: 3, ciphertext: 'not valid base64!', iv: IV_A, updatedAt: 1400 })
      .expect(400);

    await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 4, baseVersion: 3, ciphertext: CIPHER_A, iv: 'not-base64!', updatedAt: 1400 })
      .expect(400);

    await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('test_secret_key_1234567890'))
      .send({ version: 4, baseVersion: 3, ciphertext: CIPHER_A, iv: 'A'.repeat(65), updatedAt: 1400 })
      .expect(400);
  });

  it('returns 200 OK on unauthenticated GET /health', async () => {
    const response = await request.get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('rejects an API key that is not bound to the requested account', async () => {
    const response = await request.get(`/api/v1/sync/${ACCOUNT_ID}`).set(auth('alice_test_key_1234567890')).expect(403);

    expect(response.body.message).toBe('This API key is not authorized for this account.');
    await request
      .post(`/api/v1/sync/${ACCOUNT_ID}`)
      .set(auth('alice_test_key_1234567890'))
      .send({ version: 5, ciphertext: CIPHER_X, iv: IV_X, updatedAt: 5000 })
      .expect(403);
  });

  it('allows an API key to access only its bound accounts', async () => {
    const pushed = await request
      .post(`/api/v1/sync/${ALICE_ACCOUNT_ID}`)
      .set(auth('alice_test_key_1234567890'))
      .send({ version: 1, ciphertext: CIPHER_ALICE, iv: IV_ALICE, updatedAt: 2000 })
      .expect(201);

    expect(pushed.body).toEqual({ status: 'success', version: 1, updatedAt: 2000 });

    const fetched = await request.get(`/api/v1/sync/${ALICE_ACCOUNT_ID}`).set(auth('alice_test_key_1234567890')).expect(200);
    expect(fetched.body.ciphertext).toBe(CIPHER_ALICE);
  });

  it('lets the legacy key (all accounts) access another key\'s account', async () => {
    const response = await request.get(`/api/v1/sync/${ALICE_ACCOUNT_ID}`).set(auth('test_secret_key_1234567890')).expect(200);

    expect(response.body.ciphertext).toBe(CIPHER_ALICE);
  });

  it('uses POST ETag directly in If-None-Match to get 304 without a full GET', async () => {
    const pushed = await request
      .post(`/api/v1/sync/${ALICE_ACCOUNT_ID}`)
      .set(auth('alice_test_key_1234567890'))
      .send({ version: 2, baseVersion: 1, ciphertext: CIPHER_ALICE, iv: IV_ALICE, updatedAt: 2500 })
      .expect(201);

    expect(pushed.headers.etag).toBe('"v2-2500"');

    const cached = await request
      .get(`/api/v1/sync/${ALICE_ACCOUNT_ID}`)
      .set(auth('alice_test_key_1234567890'))
      .set('If-None-Match', pushed.headers.etag)
      .expect(304);

    expect(cached.headers.etag).toBe('"v2-2500"');
    expect(cached.text).toBe('');
  });
});

describe('parseTrustProxy', () => {
  it('defaults to loopback and uniquelocal and parses explicit values', () => {
    expect(parseTrustProxy(undefined)).toEqual(['loopback', 'uniquelocal']);
    expect(parseTrustProxy('   ')).toEqual(['loopback', 'uniquelocal']);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('FALSE')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('127.0.0.1')).toBe('127.0.0.1');
    expect(parseTrustProxy('127.0.0.1, 172.18.0.1')).toEqual(['127.0.0.1', '172.18.0.1']);
  });

  it('trusts X-Forwarded-For from loopback and Docker bridge IPs but not public IPs', async () => {
    const fastify = new FastifyAdapter({ trustProxy: parseTrustProxy(undefined) }).getInstance();
    fastify.get('/ip', (req) => ({ ip: req.ip }));

    const fromLoopback = await fastify.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.10' }
    });
    expect(fromLoopback.json()).toEqual({ ip: '198.51.100.10' });

    const fromDockerBridge = await fastify.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '172.18.0.1',
      headers: { 'x-forwarded-for': '198.51.100.20' }
    });
    expect(fromDockerBridge.json()).toEqual({ ip: '198.51.100.20' });

    const fromUntrustedPublic = await fastify.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '203.0.113.5',
      headers: { 'x-forwarded-for': '198.51.100.30' }
    });
    expect(fromUntrustedPublic.json()).toEqual({ ip: '203.0.113.5' });

    await fastify.close();
  });
});