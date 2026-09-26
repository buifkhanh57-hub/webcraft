#!/usr/bin/env node
/**
 * @module cli
 *
 * webcraft command line interface.
 *
 *   webcraft new <name> [--dir <path>] [--force]   Scaffold a new application
 *   webcraft routes <file>                          Print the route table
 *   webcraft --version | -v                         Print version
 *   webcraft help | --help                          Show help
 *
 * @example
 * $ webcraft new my-site
 * $ cd my-site && npm install && npm start
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** CLI usage text. */
const HELP = `webcraft — zero-dependency web framework for Node.js

Usage:
  webcraft new <name> [options]    Scaffold a new application
  webcraft routes <file>           Print the route table of an app module
  webcraft --version               Print the framework version
  webcraft help                    Show this help

Options for "new":
  --dir <path>   Target directory (default: ./<name>)
  --force        Overwrite existing files

Examples:
  webcraft new blog
  webcraft new api --dir ./services/api --force
  webcraft routes ./app.js
`;

/** Exit codes used consistently across commands. */
const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 };

/**
 * Read the framework version from package.json.
 * @returns {string}
 */
function frameworkVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/**
 * Parse command line arguments into a command plus flag map.
 * @param {string[]} argv Raw process.argv slice.
 * @returns {{command: string, args: string[], flags: Record<string, string|boolean>}}
 */
function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') flags.help = true;
    else if (token === '--version' || token === '-v') flags.version = true;
    else if (token === '--force') flags.force = true;
    else if (token === '--dir') {
      const value = argv[i + 1];
      if (!value) throw new Error('--dir requires a value');
      flags.dir = value;
      i += 1;
    } else if (token.startsWith('--dir=')) {
      flags.dir = token.slice('--dir='.length);
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      args.push(token);
    }
  }
  return { command: args[0] || '', args: args.slice(1), flags };
}

/* ------------------------------------------------------------------ */
/* Scaffold templates                                                  */
/* ------------------------------------------------------------------ */

/**
 * Package.json for the generated app.
 * @param {string} name
 * @returns {string}
 */
function pkgTemplate(name) {
  return JSON.stringify(
    {
      name: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
      version: '0.1.0',
      private: true,
      type: 'module',
      description: 'A webcraft application',
      scripts: {
        start: 'node app.js',
        dev: 'node --watch app.js',
      },
      dependencies: {
        webcraft: '^1.0.0',
      },
    },
    null,
    2,
  ) + '\n';
}

/** Main application module of the generated app. */
const APP_TEMPLATE = `import path from 'node:path';
import { createApp } from 'webcraft';
import { requestLogger } from 'webcraft/lib/logger.js';
import { registerRoutes } from './routes/index.js';

const app = createApp();
app.use(requestLogger(app.logger));

const engine = app.engine({ root: 'views' });
app.locals.siteName = '__APP_NAME__';

registerRoutes(app);

app.get('/api/time', (ctx) => {
  ctx.res.json({ now: new Date().toISOString() });
});

app.notFound((ctx) => {
  ctx.res.status(404).text('Nothing here. Try / or /api/time');
});

const port = Number(process.env.PORT || 3000);

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const server = await app.listen(port, process.env.HOST || '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await server.close();
      process.exit(0);
    });
  }
}

export default app;
`;

/** Route registration module. */
const ROUTES_TEMPLATE = `/**
 * Register every application route. Grouped and named so the CLI can list
 * them via \`webcraft routes ./app.js\`.
 */
export function registerRoutes(app) {
  app.get('/', async (ctx) => {
    await ctx.render('home', {
      title: 'Home',
      items: [
        'Zero dependencies — pure Node.js stdlib',
        'Router with params, groups and named routes',
        'Sessions, templates and static files built in',
      ],
    });
  }, { name: 'home' });

  app.group('/greet', (greet) => {
    greet.get('/:name', (ctx) => {
      ctx.res.html(\`<h1>Hello, \${escapeHtml(ctx.params.name)}!</h1>\`);
    }, { name: 'greet.person' });
  });

  app.post('/echo', async (ctx) => {
    const body = await ctx.req.body();
    ctx.res.json({ youSent: body });
  }, { name: 'echo' });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => \`&#\${ch.charCodeAt(0)};\`);
}
`;

/** Layout template. */
const LAYOUT_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{ title }} · {{ siteName }}</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <header>
    <nav><a href="/">Home</a></nav>
  </header>
  <main>{{{ body }}}</main>
  <footer><small>Powered by webcraft</small></footer>
</body>
</html>
`;

/** Home template. */
const HOME_TEMPLATE = `<h1>Welcome</h1>
<p>This page was rendered by the webcraft template engine.</p>
{{#if items}}
<ul>
  {{#each items}}
  <li>{{ this }} (item @index)</li>
  {{/each}}
</ul>
{{else}}
<p>No items yet.</p>
{{/if}}
`;

/** Stylesheet. */
const CSS_TEMPLATE = `:root {
  --ink: #1f2937;
  --accent: #6366f1;
  --bg: #f9fafb;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--ink); }
header { padding: 16px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; }
nav a { color: var(--accent); text-decoration: none; font-weight: 600; }
main { max-width: 720px; margin: 40px auto; padding: 0 24px; }
footer { text-align: center; padding: 24px; color: #9ca3af; }
h1 { color: var(--accent); }
`;

/** Frontend script. */
const JS_TEMPLATE = `// Small progressive enhancement for the scaffolded site.
document.addEventListener('DOMContentLoaded', () => {
  const year = new Date().getFullYear();
  const footer = document.querySelector('footer small');
  if (footer) footer.textContent = footer.textContent + ' — ' + year;
});
`;

/** README for the generated app. */
const APP_README = (name) => `# ${name}

A [webcraft](https://github.com/buifkhanh57-hub/webcraft) application.

## Run

\`\`\`bash
npm install
npm start          # http://localhost:3000
\`\`\`

## Structure

- \`app.js\` — application factory, middleware and bootstrap
- \`routes/index.js\` — route registrations
- \`views/\` — templates (\`{{ var }}\`, \`{{#if}}\`, \`{{#each}}\`, \`{{> partial}}\`)
- \`public/\` — static assets served at \`/\`

## Environment

- \`PORT\` — listen port (default 3000)
- \`HOST\` — bind address (default 0.0.0.0)
`;

const GITIGNORE_TEMPLATE = `node_modules/
.env
*.log
dist/
`;

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/**
 * `webcraft new <name>` — write the scaffold to disk.
 * @param {string} name
 * @param {Record<string, string|boolean>} flags
 * @returns {number} Exit code.
 */
function cmdNew(name, flags) {
  if (!name) {
    process.stderr.write('error: "new" requires an application name\n');
    return EXIT.USAGE;
  }
  // The target may be a plain name ("blog") or a filesystem path
  // ("./apps/blog", "/tmp/webcraft-demo-app"). The app name is the basename.
  const target = path.resolve(process.cwd(), flags.dir || name);
  const appName = path.basename(target);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appName)) {
    process.stderr.write(`error: invalid application name "${appName}"\n`);
    return EXIT.USAGE;
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0 && !flags.force) {
    process.stderr.write(`error: directory "${target}" is not empty (use --force to overwrite)\n`);
    return EXIT.FAILURE;
  }

  /** @type {Array<[string, string]>} */
  const files = [
    ['package.json', pkgTemplate(appName)],
    ['app.js', APP_TEMPLATE.replace('__APP_NAME__', appName)],
    ['routes/index.js', ROUTES_TEMPLATE],
    ['views/layout.html', LAYOUT_TEMPLATE],
    ['views/home.html', HOME_TEMPLATE],
    ['public/css/style.css', CSS_TEMPLATE],
    ['public/js/main.js', JS_TEMPLATE],
    ['README.md', APP_README(appName)],
    ['.gitignore', GITIGNORE_TEMPLATE],
  ];

  for (const [relative, content] of files) {
    const filePath = path.join(target, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    process.stdout.write(`  create  ${relative}\n`);
  }

  process.stdout.write(`\nScaffolded "${appName}" in ${target}\nNext steps:\n  cd ${path.relative(process.cwd(), target) || '.'}\n  npm install\n  npm start\n`);
  return EXIT.OK;
}

/**
 * `webcraft routes <file>` — import an app module and print its routes.
 * @param {string} file
 * @returns {Promise<number>} Exit code.
 */
async function cmdRoutes(file) {
  if (!file) {
    process.stderr.write('error: "routes" requires a module path\n');
    return EXIT.USAGE;
  }
  const absolute = path.resolve(process.cwd(), file);
  if (!fs.existsSync(absolute)) {
    process.stderr.write(`error: file not found: ${absolute}\n`);
    return EXIT.FAILURE;
  }
  let mod;
  try {
    mod = await import(`file://${absolute}`);
  } catch (err) {
    process.stderr.write(`error: could not import ${file}: ${err.message}\n`);
    return EXIT.FAILURE;
  }
  const candidate = mod.default || mod.app;
  if (!candidate || !candidate.router) {
    process.stderr.write('error: module does not export a webcraft app (default export)\n');
    return EXIT.FAILURE;
  }
  const routes = candidate.describeRoutes();
  const width = Math.max(...routes.map((r) => r.method.length), 6);
  process.stdout.write(`${'Method'.padEnd(width)}  Pattern\n`);
  process.stdout.write(`${'-'.repeat(width)}  ${'-'.repeat(40)}\n`);
  for (const route of routes) {
    const nameSuffix = route.name ? `   # ${route.name}` : '';
    process.stdout.write(`${route.method.padEnd(width)}  ${route.pattern}${nameSuffix}\n`);
  }
  process.stdout.write(`\n${routes.length} route(s)\n`);
  return EXIT.OK;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * CLI main.
 * @returns {Promise<number>}
 */
async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    process.stdout.write(`webcraft v${frameworkVersion()}\n`);
    return EXIT.OK;
  }
  if (flags.help || command === 'help' || command === '') {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  if (command === 'new') return cmdNew(args[0], flags);
  if (command === 'routes') return cmdRoutes(args[0]);

  process.stderr.write(`error: unknown command "${command}"\n\n${HELP}`);
  return EXIT.USAGE;
}

// Only run as the entry module (still works when bundled via npm bin link)
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = EXIT.FAILURE;
    });
}

export { main, parseArgs, cmdNew, cmdRoutes };
