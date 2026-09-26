/**
 * @module template
 *
 * A tiny, dependency-free template engine with:
 *
 * - `{{ name }}` interpolated, HTML-escaped variables
 * - `{{{ name }}}` raw (unescaped) variables
 * - `{{#if cond}}…{{else}}…{{/if}}` conditionals
 * - `{{#each items}}…{{/each}}` iteration with `@index`, `@key`,
 *   `@first`, `@last` and `this`
 * - `{{> partial}}` and `{{> partial ctx}}` partial inclusion
 * - `{{! comment }}` comments
 *
 * Expressions are simple dot paths (`user.name`), literals, or comparisons
 * (`==`, `!=`, `>`, `<`, `>=`, `<=`, `and`, `or`, `!`). There is **no eval**:
 * everything is compiled to an AST of closures.
 *
 * @example
 * const engine = new TemplateEngine({ root: './views' });
 * engine.registerPartial('greet', 'Hello {{ name }}!');
 * await engine.renderString('{{> greet}}', { name: 'World' }); // "Hello World!"
 */

import path from 'node:path';
import fsp from 'node:fs/promises';

/** HTML-escape a value for safe interpolation. */
const ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

const ESCAPE_RE = /[&<>"']/g;

/**
 * Escape a string for HTML output.
 * @param {*} value Any value; non-strings are String()-ed first.
 * @returns {string}
 *
 * @example
 * escapeHtml('<script>&"'); // '&lt;script&gt;&amp;&quot;'
 */
export function escapeHtml(value) {
  const str = value === undefined || value === null ? '' : String(value);
  return str.replace(ESCAPE_RE, (ch) => ESCAPES[ch]);
}

/**
 * Error thrown for template syntax problems, carrying the partial name.
 */
export class TemplateError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {string} [options.template] Template/partial name where it happened.
   * @param {Error} [options.cause]
   */
  constructor(message, options = {}) {
    super(options.template ? `${message} (in template "${options.template}")` : message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'TemplateError';
    this.template = options.template;
    if (Error.captureStackTrace) Error.captureStackTrace(this, TemplateError);
  }
}

/**
 * Split a template source into text and tag tokens.
 * @param {string} source
 * @returns {Array<{type:'text', value:string}|{type:'tag', value:string, raw:boolean}>}
 */
function tokenize(source) {
  const tokens = [];
  let pos = 0;
  while (pos < source.length) {
    const open = source.indexOf('{{', pos);
    if (open === -1) {
      tokens.push({ type: 'text', value: source.slice(pos) });
      break;
    }
    if (open > pos) tokens.push({ type: 'text', value: source.slice(pos, open) });
    const isRaw = source.startsWith('{{{', open);
    const closeToken = isRaw ? '}}}' : '}}';
    const close = source.indexOf(closeToken, open + (isRaw ? 3 : 2));
    if (close === -1) {
      tokens.push({ type: 'text', value: source.slice(open) });
      break;
    }
    const content = source.slice(open + (isRaw ? 3 : 2), close).trim();
    tokens.push({ type: 'tag', value: content, raw: isRaw });
    pos = close + closeToken.length;
  }
  return tokens;
}

/** Tags that terminate a block being parsed. */
const STOP_TAGS = ['else', '/if', '/each'];

/**
 * Recursive-descent parser turning tokens into an AST.
 * @param {Array} tokens
 * @param {number} start
 * @param {string[]} [stops] Tags that end this block.
 * @param {string} [templateName] For error messages.
 * @returns {{nodes: Array, next: number, stop: (string|null)}}
 */
function parseNodes(tokens, start, stops, templateName) {
  const nodes = [];
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.type === 'text') {
      if (token.value !== '') nodes.push({ type: 'text', value: token.value });
      i += 1;
      continue;
    }
    const tag = token.value;
    if (stops && stops.includes(tag)) {
      return { nodes, next: i, stop: tag };
    }
    if (tag === '' || tag.startsWith('!')) {
      i += 1;
      continue;
    }
    if (tag.startsWith('#if')) {
      const cond = tag.slice(3).trim();
      if (!cond) throw new TemplateError('#if requires a condition', { template: templateName });
      const branch = parseNodes(tokens, i + 1, STOP_TAGS, templateName);
      if (branch.stop === null) throw new TemplateError('Unclosed #if block (missing {{/if}})', { template: templateName });
      let elseNodes = [];
      let end = branch.next;
      if (branch.stop === 'else') {
        const other = parseNodes(tokens, branch.next + 1, ['/if'], templateName);
        if (other.stop === null) throw new TemplateError('Unclosed #else block (missing {{/if}})', { template: templateName });
        elseNodes = other.nodes;
        end = other.next;
      }
      nodes.push({ type: 'if', cond, then: branch.nodes, else: elseNodes });
      i = end + 1;
      continue;
    }
    if (tag.startsWith('#each')) {
      const listExpr = tag.slice(5).trim();
      if (!listExpr) throw new TemplateError('#each requires an expression', { template: templateName });
      const body = parseNodes(tokens, i + 1, ['/each'], templateName);
      if (body.stop === null) throw new TemplateError('Unclosed #each block (missing {{/each}})', { template: templateName });
      nodes.push({ type: 'each', list: listExpr, body: body.nodes });
      i = body.next + 1;
      continue;
    }
    if (tag.startsWith('>')) {
      const parts = tag.slice(1).trim().split(/\s+/);
      if (!parts[0]) throw new TemplateError('Partial inclusion requires a name', { template: templateName });
      nodes.push({
        type: 'partial',
        name: stripQuotes(parts[0]),
        context: parts.length > 1 ? parts.slice(1).join(' ') : null,
      });
      i += 1;
      continue;
    }
    nodes.push({ type: 'var', expr: tag, raw: token.raw === true });
    i += 1;
  }
  if (stops && stops.length > 0) {
    throw new TemplateError(`Unclosed block — expected one of: ${stops.join(', ')}`, { template: templateName });
  }
  return { nodes, next: i, stop: null };
}

/**
 * Remove surrounding quotes from a partial name token.
 * @param {string} token
 * @returns {string}
 */
function stripQuotes(token) {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Scan for the first top-level occurrence of any needle (not inside quotes).
 * @param {string} expr
 * @param {string[]} needles Ordered by length, longest first.
 * @returns {number} Index or -1.
 */
function scanTopLevel(expr, needles) {
  let quote = null;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    for (const needle of needles) {
      if (expr.startsWith(needle, i)) return i;
    }
  }
  return -1;
}

const OR_TOKENS = [' || ', ' or '];
const AND_TOKENS = [' && ', ' and '];
const COMPARE_TOKENS = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];

/**
 * Compile an expression string into a resolver function.
 * @param {string} expr
 * @returns {function(object): *} Resolver taking a render context.
 */
function compileExpr(expr) {
  const trimmed = expr.trim();
  if (trimmed === '') return () => undefined;

  const orIdx = scanTopLevel(trimmed, OR_TOKENS);
  if (orIdx !== -1) {
    for (const token of OR_TOKENS) {
      const idx = scanTopLevel(trimmed, [token]);
      if (idx !== -1) {
        const left = compileExpr(trimmed.slice(0, idx));
        const right = compileExpr(trimmed.slice(idx + token.length));
        return (ctx) => truthy(left(ctx)) || truthy(right(ctx));
      }
    }
  }
  const andIdx = scanTopLevel(trimmed, AND_TOKENS);
  if (andIdx !== -1) {
    for (const token of AND_TOKENS) {
      const idx = scanTopLevel(trimmed, [token]);
      if (idx !== -1) {
        const left = compileExpr(trimmed.slice(0, idx));
        const right = compileExpr(trimmed.slice(idx + token.length));
        return (ctx) => truthy(left(ctx)) && truthy(right(ctx));
      }
    }
  }
  const cmpIdx = scanTopLevel(trimmed, COMPARE_TOKENS);
  if (cmpIdx !== -1) {
    let op = '';
    for (const token of COMPARE_TOKENS) {
      if (trimmed.startsWith(token, cmpIdx)) {
        op = token;
        break;
      }
    }
    const left = compileExpr(trimmed.slice(0, cmpIdx));
    const right = compileExpr(trimmed.slice(cmpIdx + op.length));
    return (ctx) => compare(left(ctx), op, right(ctx));
  }
  if (trimmed.startsWith('!')) {
    const inner = compileExpr(trimmed.slice(1));
    return (ctx) => !truthy(inner(ctx));
  }
  if (trimmed.startsWith('not ')) {
    const inner = compileExpr(trimmed.slice(4));
    return (ctx) => !truthy(inner(ctx));
  }
  if (trimmed.startsWith('@') || trimmed === 'this') {
    return (ctx) => resolveSpecial(trimmed, ctx);
  }
  if (/^(["']).*\1$/.test(trimmed)) {
    const literal = stripQuotes(trimmed);
    return () => literal;
  }
  if (trimmed === 'true') return () => true;
  if (trimmed === 'false') return () => false;
  if (trimmed === 'null') return () => null;
  if (trimmed === 'undefined') return () => undefined;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return () => num;
  }
  return createPathResolver(trimmed);
}

/**
 * Build a resolver walking the context stack from innermost scope outward.
 * @param {string} pathExpr Dot-separated path, e.g. "user.profile.name".
 * @returns {function(object): *}
 */
function createPathResolver(pathExpr) {
  const segments = pathExpr.split('.').map((s) => s.trim()).filter(Boolean);
  return function resolvePath(ctx) {
    for (let s = ctx.stack.length - 1; s >= 0; s -= 1) {
      const value = walk(ctx.stack[s], segments);
      if (value !== undefined) return value;
    }
    return undefined;
  };
}

/**
 * Walk an object along path segments.
 * @param {*} root
 * @param {string[]} segments
 * @returns {*}
 */
function walk(root, segments) {
  let current = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Resolve `this` / `@index` / `@key` / `@first` / `@last`.
 * @param {string} expr
 * @param {object} ctx
 * @returns {*}
 */
function resolveSpecial(expr, ctx) {
  if (expr === 'this' || expr === '@this') return ctx.stack[ctx.stack.length - 1];
  const meta = ctx.meta[ctx.meta.length - 1];
  if (!meta) return undefined;
  switch (expr) {
    case '@index': return meta.index;
    case '@key': return meta.key;
    case '@first': return meta.first;
    case '@last': return meta.last;
    default: return undefined;
  }
}

/**
 * JS-style truthiness used by #if / and / or.
 * @param {*} value
 * @returns {boolean}
 */
function truthy(value) {
  return Boolean(value);
}

/**
 * Apply a comparison operator (loose semantics for == and !=).
 * @param {*} left
 * @param {string} op
 * @param {*} right
 * @returns {boolean}
 */
function compare(left, op, right) {
  switch (op) {
    case '===': return left === right;
    case '!==': return left !== right;
    case '==': return left == right; // eslint-disable-line eqeqeq
    case '!=': return left != right; // eslint-disable-line eqeqeq
    case '>': return left > right;
    case '<': return left < right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    default: return false;
  }
}

/**
 * Render a parsed AST against a context.
 * @param {Array} nodes
 * @param {object} ctx
 * @param {TemplateEngine} engine
 * @returns {Promise<string>}
 */
async function renderNodes(nodes, ctx, engine) {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.value;
        break;
      case 'var': {
        const resolver = engine._expr(node.expr);
        const value = resolver(ctx);
        out += node.raw ? String(value ?? '') : escapeHtml(value);
        break;
      }
      case 'if': {
        const cond = engine._expr(node.cond);
        out += truthy(cond(ctx)) ? await renderNodes(node.then, ctx, engine) : await renderNodes(node.else, ctx, engine);
        break;
      }
      case 'each': {
        const listResolver = engine._expr(node.list);
        const list = listResolver(ctx);
        out += await renderEach(list, node.body, ctx, engine);
        break;
      }
      case 'partial': {
        const override = node.context ? engine._expr(node.context)(ctx) : undefined;
        out += await engine.renderPartial(node.name, ctx, override);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Render the body of an #each block over an array or object.
 * @param {*} list
 * @param {Array} body
 * @param {object} ctx
 * @param {TemplateEngine} engine
 * @returns {Promise<string>}
 */
async function renderEach(list, body, ctx, engine) {
  if (list === undefined || list === null) return '';
  let out = '';
  if (Array.isArray(list)) {
    for (let index = 0; index < list.length; index += 1) {
      ctx.meta.push({ index, key: index, first: index === 0, last: index === list.length - 1 });
      ctx.stack.push(list[index]);
      out += await renderNodes(body, ctx, engine);
      ctx.stack.pop();
      ctx.meta.pop();
    }
    return out;
  }
  if (typeof list === 'object') {
    const keys = Object.keys(list);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      ctx.meta.push({ index, key, first: index === 0, last: index === keys.length - 1 });
      ctx.stack.push(list[key]);
      out += await renderNodes(body, ctx, engine);
      ctx.stack.pop();
      ctx.meta.pop();
    }
  }
  return out;
}

/**
 * The template engine. Instances own partial registries and compiled caches.
 */
export class TemplateEngine {
  /**
   * @param {object} [options]
   * @param {string} [options.root] Directory templates/partials load from.
   * @param {string} [options.extension='.html'] Default file extension.
   * @param {boolean} [options.cache=true] Cache compiled templates.
   */
  constructor(options = {}) {
    this.root = options.root ? path.resolve(options.root) : null;
    this.extension = options.extension || '.html';
    this.cacheEnabled = options.cache !== false;
    /** @type {Map<string, string>} */
    this.partials = new Map();
    /** @type {Map<string, function(object): Promise<string>>} */
    this._compiled = new Map();
    /** @type {Map<string, function(*): *>} */
    this._exprCache = new Map();
  }

  /**
   * Register an inline partial.
   * @param {string} name
   * @param {string} source
   * @returns {TemplateEngine} this
   */
  registerPartial(name, source) {
    if (typeof name !== 'string' || name === '') throw new TypeError('Partial name must be a non-empty string');
    if (typeof source !== 'string') throw new TypeError('Partial source must be a string');
    this.partials.set(name, source);
    if (this.cacheEnabled) this._compiled.delete(`partial:${name}`);
    return this;
  }

  /** @returns {boolean} Whether a partial is registered or loadable. */
  hasPartial(name) {
    return this.partials.has(name);
  }

  /** @returns {string[]} Names of registered inline partials. */
  partialNames() {
    return [...this.partials.keys()];
  }

  /**
   * Load partial source: registry first, then the filesystem.
   * @param {string} name
   * @returns {Promise<string>}
   * @throws {TemplateError} When the partial cannot be found.
   */
  async loadPartial(name) {
    if (this.partials.has(name)) return this.partials.get(name);
    if (this.root) {
      const file = name.endsWith(this.extension) ? name : `${name}${this.extension}`;
      try {
        const source = await fsp.readFile(path.join(this.root, file), 'utf8');
        return source;
      } catch (err) {
        throw new TemplateError(`Partial "${name}" not found in ${this.root}`, { template: name, cause: err });
      }
    }
    throw new TemplateError(`Partial "${name}" is not registered`, { template: name });
  }

  /**
   * Compile source into an async render function (cached).
   * @param {string} source
   * @param {string} [name] For error reporting.
   * @returns {function(object): Promise<string>}
   */
  compile(source, name = '<inline>') {
    const cacheKey = `src:${source}`;
    if (this.cacheEnabled && this._compiled.has(cacheKey)) return this._compiled.get(cacheKey);
    const { nodes } = parseNodes(tokenize(source), 0, null, name);
    const engine = this;
    /**
     * @param {object} data Root data.
     * @returns {Promise<string>}
     */
    const render = async (data) => {
      const ctx = { stack: [data === undefined || data === null ? {} : data], meta: [] };
      return renderNodes(nodes, ctx, engine);
    };
    // Allow partials to run inside an existing render context (scope stack)
    render.__runWith = (ctx) => renderNodes(nodes, ctx, engine);
    if (this.cacheEnabled) this._compiled.set(cacheKey, render);
    return render;
  }

  /**
   * Compile (and cache) a single expression — internal helper exposed for
   * extensibility.
   * @param {string} expr
   * @returns {function(object): *}
   * @private
   */
  _expr(expr) {
    if (this.cacheEnabled) {
      let resolver = this._exprCache.get(expr);
      if (!resolver) {
        resolver = compileExpr(expr);
        this._exprCache.set(expr, resolver);
      }
      return resolver;
    }
    return compileExpr(expr);
  }

  /**
   * Render a partial by name with an explicit or inherited context.
   * @param {string} name
   * @param {object} [parentCtx] Current render context.
   * @param {*} [overrideRoot] Root value when `{{> name ctx}}` was used.
   * @returns {Promise<string>}
   */
  async renderPartial(name, parentCtx, overrideRoot) {
    const cacheKey = `partial:${name}`;
    let render = this._compiled.get(cacheKey);
    if (!render) {
      const source = await this.loadPartial(name);
      render = this.compile(source, name);
      if (this.cacheEnabled) this._compiled.set(cacheKey, render);
    }
    if (parentCtx && overrideRoot === undefined) {
      return render.__runWith(parentCtx);
    }
    return render(overrideRoot === undefined || overrideRoot === null ? {} : overrideRoot);
  }

  /**
   * Render a template source string.
   * @param {string} source
   * @param {object} [data]
   * @returns {Promise<string>}
   */
  async renderString(source, data = {}) {
    return this.compile(source)(data);
  }

  /**
   * Render a named template (registry or file).
   * @param {string} name
   * @param {object} [data]
   * @returns {Promise<string>}
   * @throws {TemplateError}
   */
  async render(name, data = {}) {
    const source = await this.loadPartial(name);
    return this.compile(source, name)(data);
  }
}
