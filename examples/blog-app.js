/**
 * @file examples/blog-app.js
 *
 * Example blog built with webcraft. Demonstrates:
 * - file-based templates ({{ var }}, {{#if}}, {{#each}}, {{{ raw }}}) with a
 *   layout template wrapping per-page partials
 * - cookie sessions with login/logout and a protected admin page
 * - static assets served from examples/public
 * - form handling with urlencoded bodies and redirects
 *
 * Run:
 *   node examples/blog-app.js            # listens on :3000
 *   PORT=4000 node examples/blog-app.js  # custom port
 *
 * Try:
 *   curl -s localhost:3000/
 *   curl -s localhost:3000/posts/hello-webcraft
 *   curl -s localhost:3000/assets/css/blog.css -o /dev/null -w '%{http_code}\n'
 *   curl -si -X POST localhost:3000/login -d 'username=editor&password=craft'
 */

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/webcraft.js';
import { requestLogger } from '../lib/logger.js';
import { createStatic } from '../lib/static.js';
import { mount } from '../lib/middleware.js';
import { session } from '../lib/session.js';
import { NotFoundError } from '../lib/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------------ */
/* In-memory content store                                             */
/* ------------------------------------------------------------------ */

/** @type {Array<{slug: string, title: string, excerpt: string, body: string, author: string, date: string}>} */
const posts = [
  {
    slug: 'hello-webcraft',
    title: 'Hello, webcraft',
    excerpt: 'A zero-dependency web framework, in one file or twenty.',
    body: 'webcraft is built entirely on the Node.js standard library.\nNo npm install, no build step, no transpiler — just modules.',
    author: 'editor',
    date: '2024-11-02',
  },
  {
    slug: 'routing-guide',
    title: 'Routing: params, groups and named routes',
    excerpt: 'From /posts/:slug to router.url("posts.show", { slug }).',
    body: 'Patterns compile to regular expressions once at startup.\nGroups nest, wildcards span segments, and 405 replies carry an Allow header.',
    author: 'editor',
    date: '2024-11-09',
  },
  {
    slug: 'sessions-without-storage',
    title: 'Cookie sessions without server-side storage',
    excerpt: 'HMAC-signed payloads make tiny sessions easy.',
    body: 'The session payload lives inside the cookie, signed with HMAC-SHA256.\nTamper with it and the signature check drops it on the floor.',
    author: 'khanh',
    date: '2024-11-21',
  },
];

const credentials = new Map([
  ['editor', 'craft'],
  ['khanh', 'demo'],
]);

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

const app = createApp({ env: process.env.NODE_ENV || 'development' });

app.use(requestLogger(app.logger, { skip: (ctx) => ctx.req.path.startsWith('/assets') }));
app.use(session({ secret: process.env.SESSION_SECRET || 'blog-demo-secret', key: 'blog.sid' }));
// examples/public is mounted at /assets (public/css/blog.css → /assets/css/blog.css)
app.use(mount('/assets', createStatic(path.join(__dirname, 'public'), { maxAge: 3600 })));

app.locals.site = 'Craftblog';

const engine = app.engine({ root: path.join(__dirname, 'views') });

/**
 * Render a page partial, wrap it in the layout template and send it.
 * Layout variables (site name, current user) are added automatically.
 * @param {object} ctx
 * @param {string} template Partial name inside examples/views.
 * @param {object} data Data for the partial and the layout.
 */
async function renderPage(ctx, template, data) {
  const body = await engine.render(template, data);
  await ctx.render('layout.html', {
    ...data,
    body,
    site: app.locals.site,
    user: ctx.session.get('user') || null,
  });
}

app.get('/', async (ctx) => {
  await renderPage(ctx, 'home.html', { title: 'Latest posts', posts });
});

app.get('/posts/:slug', async (ctx) => {
  const post = posts.find((p) => p.slug === ctx.params.slug);
  if (!post) throw new NotFoundError(`No post titled "${ctx.params.slug}"`);
  await renderPage(ctx, 'post.html', {
    title: post.title,
    post,
    bodySplit: post.body.split('\n'),
  });
});

app.get('/login', async (ctx) => {
  await renderPage(ctx, 'login.html', {
    title: 'Sign in',
    error: ctx.session.flash('loginError') || null,
  });
});

app.post('/login', async (ctx) => {
  const form = await ctx.req.form();
  const { username, password } = form;
  if (typeof username !== 'string' || typeof password !== 'string' || credentials.get(username) !== password) {
    ctx.session.set('loginError', 'Wrong username or password');
    ctx.redirect('/login', 303);
    return;
  }
  ctx.session.set('user', username);
  ctx.session.delete('loginError');
  ctx.redirect('/', 303);
});

app.post('/logout', (ctx) => {
  ctx.session.destroy();
  ctx.redirect('/', 303);
});

app.get('/admin', async (ctx) => {
  const user = ctx.session.get('user');
  if (!user) {
    ctx.session.set('loginError', 'Sign in to open the admin area');
    ctx.redirect('/login', 303);
    return;
  }
  await renderPage(ctx, 'admin.html', { title: 'Admin', user, count: posts.length });
});

app.notFound((ctx) => {
  ctx.res.status(404).html(`<h1>404</h1><p>Nothing at ${ctx.req.path}. <a href="/">Back home</a></p>`);
});

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

const server = await app.listen(PORT, HOST);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.logger.info(`Received ${signal}, shutting down…`);
    await server.close({ timeout: 5000 });
    process.exit(0);
  });
}

export default app;
