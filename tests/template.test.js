/**
 * Template engine tests (unit + one server-integrated render).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, withServer } from './helpers.js';
import { TemplateEngine, escapeHtml } from '../lib/template.js';

test('variables are HTML-escaped; triple braces stay raw', async () => {
  const engine = new TemplateEngine();
  assert.equal(await engine.renderString('Hi {{ name }}!', { name: '<b>Eve</b>' }), 'Hi &lt;b&gt;Eve&lt;/b&gt;!');
  assert.equal(await engine.renderString('Hi {{{ name }}}!', { name: '<b>Eve</b>' }), 'Hi <b>Eve</b>!');
  assert.equal(await engine.renderString('{{ missing }}', {}), '');
  assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
});

test('dot paths resolve into nested objects', async () => {
  const engine = new TemplateEngine();
  const out = await engine.renderString('{{ user.profile.city }} ({{ user.age }})', {
    user: { profile: { city: 'Hanoi' }, age: 30 },
  });
  assert.equal(out, 'Hanoi (30)');
});

test('#if / #else with truthiness, comparisons, and/or/not', async () => {
  const engine = new TemplateEngine();
  const tpl = '{{#if admin}}A{{else}}B{{/if}}';
  assert.equal(await engine.renderString(tpl, { admin: true }), 'A');
  assert.equal(await engine.renderString(tpl, { admin: 0 }), 'B');
  assert.equal(await engine.renderString('{{#if age >= 18}}adult{{/if}}', { age: 21 }), 'adult');
  assert.equal(await engine.renderString('{{#if age >= 18}}adult{{/if}}', { age: 12 }), '');
  assert.equal(await engine.renderString('{{#if role == "admin"}}ok{{/if}}', { role: 'admin' }), 'ok');
  assert.equal(await engine.renderString('{{#if role != "admin"}}no{{/if}}', { role: 'user' }), 'no');
  assert.equal(await engine.renderString('{{#if a and b}}both{{/if}}', { a: 1, b: 1 }), 'both');
  assert.equal(await engine.renderString('{{#if a or b}}either{{/if}}', { a: 0, b: 1 }), 'either');
  assert.equal(await engine.renderString('{{#if not banned}}allowed{{/if}}', { banned: false }), 'allowed');
  assert.equal(await engine.renderString('{{#if !banned}}allowed{{/if}}', { banned: false }), 'allowed');
});

test('#each over arrays (with @index/@first/@last/this) and objects (@key)', async () => {
  const engine = new TemplateEngine();
  assert.equal(await engine.renderString('{{#each items}}<li>{{ name }} #{{ @index }}</li>{{/each}}', { items: [{ name: 'a' }, { name: 'b' }] }), '<li>a #0</li><li>b #1</li>');
  assert.equal(await engine.renderString('{{#each tags}}{{ this }};{{/each}}', { tags: ['x', 'y'] }), 'x;y;');
  assert.equal(await engine.renderString('{{#each map}}{{ @key }}={{ this }}&{{/each}}', { map: { a: 1, b: 2 } }), 'a=1&b=2&');
  assert.equal(await engine.renderString('{{#each none}}x{{/each}}end', { none: null }), 'end');
});

test('partials inherit context; explicit context overrides it', async () => {
  const engine = new TemplateEngine();
  engine.registerPartial('row', '<tr>{{ name }}</tr>');
  assert.equal(await engine.renderString('{{#each users}}{{> row}}{{/each}}', { users: [{ name: 'A' }, { name: 'B' }] }), '<tr>A</tr><tr>B</tr>');
  engine.registerPartial('card', '[{{ title }}]');
  assert.equal(await engine.renderString('{{> card page}}', { page: { title: 'Home' }, ignored: true }), '[Home]');
});

test('comments are stripped and unclosed blocks raise TemplateError', async () => {
  const engine = new TemplateEngine();
  assert.equal(await engine.renderString('a{{! hidden }}b', {}), 'ab');
  await assert.rejects(() => engine.renderString('{{#each items}}x', {}), /Unclosed/);
  await assert.rejects(() => engine.renderString('{{#if x}}y', {}), /Unclosed/);
});

test('compilation cache refreshes when a partial is re-registered', async () => {
  const engine = new TemplateEngine();
  engine.registerPartial('greet', 'v1 {{ who }}');
  assert.equal(await engine.renderString('{{> greet}}', { who: 'x' }), 'v1 x');
  engine.registerPartial('greet', 'v2 {{ who }}');
  assert.equal(await engine.renderString('{{> greet}}', { who: 'x' }), 'v2 x');
});

test('file-based templates and partials load from the configured root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcraft-views-'));
  fs.writeFileSync(path.join(root, 'nav.html'), '<nav>{{ brand }}</nav>');
  fs.writeFileSync(path.join(root, 'page.html'), `<!doctype html>\n{{> nav}}<h1>{{ title }}</h1>`);

  const engine = new TemplateEngine({ root });
  assert.equal(await engine.render('page', { brand: 'WC', title: 'Body' }), '<!doctype html>\n<nav>WC</nav><h1>Body</h1>');
  await assert.rejects(() => engine.render('nope', {}), /not found/);
});

test('app.engine() + ctx.render() serve rendered templates with app.locals merged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcraft-views-'));
  fs.writeFileSync(path.join(root, 'hello.html'), '<h1>{{ site }} · {{ who }}</h1>');

  const app = createApp();
  app.engine({ root });
  app.locals.site = 'webcraft';
  app.get('/', async (ctx) => { await ctx.render('hello', { who: 'world' }); });
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/`);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(await res.text(), '<h1>webcraft · world</h1>');
  });
});

test('ctx.render without a configured engine → 500 with a helpful message', async () => {
  const app = createApp();
  app.get('/nope', async (ctx) => { await ctx.render('x'); });
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/nope`);
    assert.equal(res.status, 500);
  });
});
