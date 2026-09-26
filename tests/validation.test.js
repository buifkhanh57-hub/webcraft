/**
 * Schema validation tests: unit-level rules plus the validate()/validateQuery()
 * middleware over real HTTP requests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, withServer } from './helpers.js';
import { Schema, validate, validateQuery, validateBody, ValidationError, isEmail, isUrl } from '../lib/validation.js';

test('required / missing / default handling', () => {
  const schema = new Schema({
    name: (f) => f.required().string(),
    page: (f) => f.number().default(1),
  });
  const ok = schema.validate({ name: 'Ada' });
  assert.ok(ok.ok);
  assert.deepEqual(ok.data, { name: 'Ada', page: 1 });

  const bad = schema.validate({});
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].field, 'name');
  assert.equal(bad.errors[0].rule, 'required');
});

test('coercion: numeric + boolean strings, trim/lower/upper', () => {
  const schema = new Schema({
    age: (f) => f.number(),
    active: (f) => f.boolean(),
    name: (f) => f.string().trim().upper(),
  });
  const { ok, data } = schema.validate({ age: '42', active: 'yes', name: '  ada  ' });
  assert.ok(ok);
  assert.deepEqual(data, { age: 42, active: true, name: 'ADA' });

  const strict = new Schema({ age: (f) => f.number() });
  const result = strict.validate({ age: 'not-a-number' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].rule, 'number');
});

test('string rules: min/max/length/email/url/regex/oneOf/custom', () => {
  const schema = new Schema({
    handle: (f) => f.string().min(2).max(5),
    exact: (f) => f.string().length(4),
    mail: (f) => f.string().email(),
    site: (f) => f.string().url(),
    code: (f) => f.string().regex(/^[A-Z]{3}$/),
    role: (f) => f.oneOf(['admin', 'user']),
    even: (f) => f.custom((v) => v % 2 === 0, 'must be even'),
  });

  assert.ok(schema.validate({ handle: 'abc', exact: 'abcd', mail: 'a@b.co', site: 'https://x.dev', code: 'ABC', role: 'admin', even: 4 }).ok);

  const bad = schema.validate({ handle: 'toolongvalue', exact: 'no', mail: 'nope', site: 'ftp://x', code: 'ab', role: 'ghost', even: 3 });
  assert.equal(bad.ok, false);
  const rules = bad.errors.map((e) => e.rule).sort();
  assert.deepEqual(rules, ['custom', 'email', 'length', 'max', 'oneOf', 'regex', 'url']);
});

test('custom validator object verdicts and thrown errors', () => {
  const schema = new Schema({
    a: (f) => f.custom(() => ({ ok: false, message: 'nope' })),
    b: (f) => f.custom(() => { throw new Error('boom'); }),
  });
  const result = schema.validate({ a: 1, b: 2 });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((e) => e.message).sort(),
    ['boom', 'nope'],
  );
});

test('nested objects via fields() and arrays via items()', () => {
  const schema = new Schema({
    profile: (f) => f.object().fields({ name: (n) => n.required().string().min(2) }),
    scores: (f) => f.array().items((i) => i.number().min(0).max(10)),
  });
  const good = schema.validate({ profile: { name: 'Ada' }, scores: [1, '5', 10] });
  assert.ok(good.ok);
  assert.deepEqual(good.data, { profile: { name: 'Ada' }, scores: [1, 5, 10] });

  const bad = schema.validate({ profile: { name: 'x' }, scores: [11] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.field === 'profile.name'));
  assert.ok(bad.errors.some((e) => e.field === 'scores[0]'));
});

test('stripUnknown drops unknown keys; unknown keys are kept by default', () => {
  const schema = new Schema({ a: (f) => f.number() });
  const kept = schema.validate({ a: 1, evil: '<script>' });
  assert.equal(kept.data.evil, '<script>');
  const stripped = schema.validate({ a: 1, evil: 'x' }, { stripUnknown: true });
  assert.equal('evil' in stripped.data, false);
});

test('abortEarly stops at the first failure', () => {
  const schema = new Schema({
    a: (f) => f.required().number(),
    b: (f) => f.required().number(),
  });
  const result = schema.validate({ a: 'x', b: 'y' }, { abortEarly: true });
  assert.equal(result.errors.length, 1);
});

test('validateOrThrow raises ValidationError with details', () => {
  const schema = new Schema({ id: (f) => f.required().number() });
  assert.throws(() => schema.validateOrThrow({}), ValidationError);
  try {
    schema.validateOrThrow({});
  } catch (err) {
    assert.equal(err.status, 422);
    assert.equal(err.errors[0].field, 'id');
    assert.ok(err.isHttpError);
  }
});

test('validate() middleware: 422 with structured details over HTTP', async () => {
  const app = createApp();
  const schema = new Schema({
    name: (f) => f.required().string().trim().length(2, 20),
    email: (f) => f.required().string().trim().lower().email(),
    age: (f) => f.number().min(13).max(120),
  });
  app.post('/users', validate(schema), (ctx) => ctx.res.status(201).json({ created: ctx.data }));
  await withServer(app, async ({ url }) => {
    const good = await fetch(`${url}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Ada  ', email: 'ADA@Example.com', age: '36' }),
    });
    assert.equal(good.status, 201);
    assert.deepEqual(await good.json(), { created: { name: 'Ada', email: 'ada@example.com', age: 36 } });

    const bad = await fetch(`${url}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', email: 'nope', age: 999 }),
    });
    assert.equal(bad.status, 422);
    const payload = await bad.json();
    assert.equal(payload.error.code, 'VALIDATION_FAILED');
    assert.equal(payload.error.details.length, 3);
    assert.deepEqual(payload.error.details.map((d) => d.field).sort(), ['age', 'email', 'name']);
  });
});

test('validateQuery() coerces query params and applies defaults', async () => {
  const app = createApp();
  const pagination = new Schema({
    page: (f) => f.number().min(1).default(1),
    limit: (f) => f.number().min(1).max(100).default(20),
  });
  app.get('/items', validateQuery(pagination), (ctx) => ctx.res.json(ctx.data));
  await withServer(app, async ({ url }) => {
    assert.deepEqual(await (await fetch(`${url}/items?page=3&limit=5`)).json(), { page: 3, limit: 5 });
    assert.deepEqual(await (await fetch(`${url}/items`)).json(), { page: 1, limit: 20 });
  });
});

test('validateBody/validate factories require Schema instances', () => {
  assert.equal(typeof validateBody, 'function');
  assert.throws(() => validate({}), TypeError);
});

test('isEmail / isUrl helpers', () => {
  assert.equal(isEmail('a@b.co'), true);
  assert.equal(isEmail('nope'), false);
  assert.equal(isUrl('https://example.com/x'), true);
  assert.equal(isUrl('javascript:alert(1)'), false);
  assert.equal(isUrl('nope'), false);
});
