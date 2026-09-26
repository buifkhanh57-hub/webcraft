/**
 * @module validation
 *
 * Declarative schema validation with coercion, nesting and custom rules.
 * Schemas are built fluently and can validate request bodies, queries or
 * arbitrary objects.
 *
 * @example
 * import { Schema, validateBody } from 'webcraft/lib/validation.js';
 *
 * const userSchema = new Schema({
 *   name: (f) => f.required().string().length(2, 80),
 *   email: (f) => f.required().string().email(),
 *   age: (f) => f.number().min(13).max(120),
 * });
 *
 * app.post('/users', validateBody(userSchema), (ctx) => {
 *   ctx.res.json({ created: ctx.data.name }); // ctx.data = cleaned values
 * });
 */

import { HttpError } from './errors.js';

/** E-mail pattern good enough for input validation (not RFC-complete). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

/**
 * Validation failure carrying the structured error list.
 */
export class ValidationError extends HttpError {
  /**
   * @param {Array<{field: string, rule: string, message: string}>} errors
   * @param {string} [message]
   */
  constructor(errors = [], message = 'Validation failed') {
    super(422, message, { code: 'VALIDATION_FAILED', details: errors });
    this.errors = errors;
  }
}

/**
 * A single field definition with chainable rules.
 */
export class FieldSchema {
  /**
   * @param {string} name Field name.
   * @param {'any'|'string'|'number'|'boolean'|'object'|'array'} [type='any']
   */
  constructor(name, type = 'any') {
    this.name = name;
    this.type = type;
    this.requiredFlag = false;
    this.rules = [];
    this.hasDefault = false;
    this.defaultValue = undefined;
    this.baseMessage = null;
    this.trimFlag = false;
    this.caseMode = null;
    this.itemsSchema = null;
    this.fieldsSchema = null;
  }

  /** Mark the field as required (falsy-but-present values still pass). */
  required() {
    this.requiredFlag = true;
    return this;
  }

  /** Mark the field as optional (explicit for readability). */
  optional() {
    this.requiredFlag = false;
    return this;
  }

  /** Force the string type. */
  string() {
    this.type = 'string';
    return this;
  }

  /** Force the number type (accepts numeric strings when coercion is on). */
  number() {
    this.type = 'number';
    return this;
  }

  /** Force the boolean type (accepts 'true'/'false'/'1'/'0' when coercing). */
  boolean() {
    this.type = 'boolean';
    return this;
  }

  /** Expect a plain object; pair with {@link FieldSchema#fields}. */
  object() {
    this.type = 'object';
    return this;
  }

  /** Expect an array; pair with {@link FieldSchema#items}. */
  array() {
    this.type = 'array';
    return this;
  }

  /**
   * Numeric/string lower bound: value >= min for numbers, length >= min otherwise.
   * @param {number} min
   * @param {string} [message]
   */
  min(min, message) {
    this.rules.push({ rule: 'min', value: min, message: message || `must be at least ${min}` });
    return this;
  }

  /**
   * Numeric/string upper bound.
   * @param {number} max
   * @param {string} [message]
   */
  max(max, message) {
    this.rules.push({ rule: 'max', value: max, message: message || `must be at most ${max}` });
    return this;
  }

  /**
   * Exact length range for strings and arrays.
   * @param {number} minOrLen
   * @param {number} [max]
   * @param {string} [message]
   */
  length(minOrLen, max, message) {
    const min = max === undefined ? minOrLen : minOrLen;
    const upper = max === undefined ? minOrLen : max;
    this.rules.push({
      rule: 'length',
      value: [min, upper],
      message: message || (min === upper ? `must be exactly ${min} characters long` : `length must be between ${min} and ${upper}`),
    });
    return this;
  }

  /** Require a plausible e-mail address. */
  email(message) {
    this.rules.push({ rule: 'email', message: message || 'must be a valid email address' });
    return this;
  }

  /** Require a parseable http(s) URL. */
  url(message) {
    this.rules.push({ rule: 'url', message: message || 'must be a valid URL' });
    return this;
  }

  /**
   * Require a custom regular expression match.
   * @param {RegExp} pattern
   * @param {string} [message]
   */
  regex(pattern, message) {
    if (!(pattern instanceof RegExp)) throw new TypeError('regex() expects a RegExp');
    this.rules.push({ rule: 'regex', value: pattern, message: message || 'has an invalid format' });
    return this;
  }

  /**
   * Whitelist of allowed values (uses === semantics via includes()).
   * @param {Array<*>} values
   * @param {string} [message]
   */
  oneOf(values, message) {
    this.rules.push({ rule: 'oneOf', value: values, message: message || `must be one of: ${values.join(', ')}` });
    return this;
  }

  /**
   * Custom validator: return truthy to pass, or `{ ok, message }` for a
   * custom message. Thrown errors are treated as failures with the error
   * message used verbatim.
   * @param {function(*, object): (boolean|{ok: boolean, message?: string})} fn
   * @param {string} [message]
   */
  custom(fn, message) {
    if (typeof fn !== 'function') throw new TypeError('custom() expects a function');
    this.rules.push({ rule: 'custom', value: fn, message: message || 'is invalid' });
    return this;
  }

  /** Default value applied when the field is missing/empty. */
  default(value) {
    this.hasDefault = true;
    this.defaultValue = value;
    return this;
  }

  /** Trim string values before rule checks. */
  trim() {
    this.trimFlag = true;
    return this;
  }

  /** Lowercase string values before rule checks. */
  lower() {
    this.caseMode = 'lower';
    return this;
  }

  /** Uppercase string values before rule checks. */
  upper() {
    this.caseMode = 'upper';
    return this;
  }

  /** Override the message for every rule on this field. */
  message(text) {
    this.baseMessage = text;
    return this;
  }

  /**
   * For array fields: schema applied to every element.
   * @param {FieldSchema|function(FieldSchema): FieldSchema|object} def
   *   A configured FieldSchema, a setup function `(f) => f.number().min(0)`
   *   or a shorthand spec object (`{ type: 'number', min: 0 }`).
   */
  items(def) {
    const schema = new Schema();
    if (def instanceof FieldSchema) {
      schema.fields.set('value', def);
    } else {
      schema.field('value', def);
    }
    this.itemsSchema = schema;
    return this;
  }

  /**
   * For object fields: nested schema.
   * @param {Schema|object} def A Schema instance or a definition object.
   */
  fields(def) {
    this.fieldsSchema = def instanceof Schema ? def : new Schema(def);
    return this;
  }
}

/**
 * Compose a field definition from a shorthand object:
 * `{ type: 'string', required: true, min: 2 }`.
 * @param {FieldSchema} field
 * @param {object} spec
 * @returns {FieldSchema}
 */
function applySpec(field, spec) {
  if (spec.type) field.type = spec.type;
  if (spec.required) field.required();
  if (spec.min !== undefined) field.min(spec.min, spec.message);
  if (spec.max !== undefined) field.max(spec.max, spec.message);
  if (spec.length !== undefined) field.length(...(Array.isArray(spec.length) ? spec.length : [spec.length]), spec.message);
  if (spec.email) field.email(spec.message);
  if (spec.url) field.url(spec.message);
  if (spec.regex) field.regex(spec.regex, spec.message);
  if (spec.oneOf) field.oneOf(spec.oneOf, spec.message);
  if (spec.default !== undefined) field.default(spec.default);
  if (spec.trim) field.trim();
  if (spec.lower) field.lower();
  if (spec.upper) field.upper();
  if (typeof spec.custom === 'function') field.custom(spec.custom, spec.message);
  return field;
}

/**
 * A validation schema: an ordered map of field definitions.
 */
export class Schema {
  /**
   * @param {object} [definition] Map of field name → setup function or spec object.
   *   Functions receive a fresh {@link FieldSchema}: `(f) => f.required().string()`.
   */
  constructor(definition = {}) {
    /** @type {Map<string, FieldSchema>} */
    this.fields = new Map();
    for (const [name, setup] of Object.entries(definition)) {
      this.field(name, setup);
    }
  }

  /**
   * Add (or replace) a field definition.
   * @param {string} name
   * @param {function(FieldSchema): FieldSchema|object} [setup]
   * @returns {FieldSchema} The created field (chainable).
   */
  field(name, setup) {
    const field = new FieldSchema(name);
    if (typeof setup === 'function') setup(field);
    else if (setup && typeof setup === 'object') applySpec(field, setup);
    this.fields.set(name, field);
    return field;
  }

  /** @returns {string[]} Ordered field names. */
  names() {
    return [...this.fields.keys()];
  }

  /**
   * Validate an input object.
   *
   * @param {*} input Value to validate (typically a parsed body).
   * @param {object} [options]
   * @param {boolean} [options.coerce=true] Coerce numeric/boolean strings.
   * @param {boolean} [options.stripUnknown=false] Drop unknown keys from output.
   * @param {boolean} [options.abortEarly=false] Stop at the first error.
   * @returns {{ok: boolean, data: object, errors: Array<{field: string, rule: string, message: string}>}}
   */
  validate(input, options = {}) {
    const coerce = options.coerce !== false;
    const stripUnknown = options.stripUnknown === true;
    const abortEarly = options.abortEarly === true;
    const errors = [];
    const data = {};

    if (input === undefined || input === null) input = {};
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, data: {}, errors: [{ field: '', rule: 'type', message: 'expected an object' }] };
    }

    for (const field of this.fields.values()) {
      let value = input[field.name];
      const missing = value === undefined || value === null || value === '';

      if (missing) {
        if (field.hasDefault) {
          data[field.name] = typeof field.defaultValue === 'function' ? field.defaultValue(input) : field.defaultValue;
        } else if (field.requiredFlag) {
          errors.push({ field: field.name, rule: 'required', message: messageFor(field, 'required', `${field.name} is required`) });
        }
        if (abortEarly && errors.length > 0) break;
        continue;
      }

      const prepared = prepareValue(field, value, coerce);
      if (prepared.error) {
        errors.push(prepared.error);
        if (abortEarly && errors.length > 0) break;
        continue;
      }
      const clean = prepared.value;

      let failed = false;
      for (const rule of field.rules) {
        const failure = checkRule(field, rule, clean, input);
        if (failure) {
          errors.push(failure);
          failed = true;
          if (abortEarly) break;
          break;
        }
      }
      if (failed && abortEarly) break;

      if (!failed) {
        if (field.type === 'object' && field.fieldsSchema) {
          const nested = field.fieldsSchema.validate(clean, { coerce, stripUnknown, abortEarly });
          if (!nested.ok) {
            for (const err of nested.errors) {
              errors.push({ ...err, field: err.field ? `${field.name}.${err.field}` : field.name });
            }
            if (abortEarly) break;
            continue;
          }
          data[field.name] = nested.data;
          continue;
        }
        if (field.type === 'array' && field.itemsSchema) {
          const list = [];
          let listFailed = false;
          for (let i = 0; i < clean.length; i += 1) {
            const itemResult = field.itemsSchema.validate({ value: clean[i] }, { coerce, stripUnknown: true, abortEarly });
            if (!itemResult.ok) {
              for (const err of itemResult.errors) {
                errors.push({ ...err, field: `${field.name}[${i}]` });
              }
              listFailed = true;
              if (abortEarly) break;
            } else {
              list.push(itemResult.data.value);
            }
          }
          if (!listFailed) data[field.name] = list;
          continue;
        }
        data[field.name] = clean;
      }
    }

    if (!stripUnknown) {
      for (const [key, value] of Object.entries(input)) {
        if (!this.fields.has(key) && !(key in data)) data[key] = value;
      }
    }

    return { ok: errors.length === 0, data, errors };
  }

  /**
   * Validate or throw a {@link ValidationError}.
   * @param {*} input
   * @param {object} [options] See {@link Schema#validate}.
   * @returns {object} Cleaned data.
   * @throws {ValidationError}
   */
  validateOrThrow(input, options = {}) {
    const result = this.validate(input, options);
    if (!result.ok) throw new ValidationError(result.errors);
    return result.data;
  }
}

/**
 * Build the final message for a failed rule.
 * @param {FieldSchema} field
 * @param {string} rule
 * @param {string} fallback
 * @returns {string}
 */
function messageFor(field, rule, fallback) {
  if (field.baseMessage) return field.baseMessage;
  return `${field.name} ${rule === 'required' ? 'is required' : fallback}`;
}

/**
 * Apply type coercion and string transforms.
 * @param {FieldSchema} field
 * @param {*} value
 * @param {boolean} coerce
 * @returns {{value: *, error?: {field: string, rule: string, message: string}}}
 */
function prepareValue(field, value, coerce) {
  let v = value;
  if (field.type === 'number') {
    if (typeof v === 'string' && coerce) {
      const trimmed = v.trim();
      if (trimmed !== '' && Number.isFinite(Number(trimmed))) v = Number(trimmed);
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { value: v, error: { field: field.name, rule: 'number', message: `${field.name} must be a number` } };
    }
  } else if (field.type === 'boolean') {
    if (typeof v === 'string' && coerce) {
      const lowered = v.trim().toLowerCase();
      if (lowered === 'true' || lowered === '1' || lowered === 'yes') v = true;
      else if (lowered === 'false' || lowered === '0' || lowered === 'no') v = false;
    }
    if (typeof v !== 'boolean') {
      return { value: v, error: { field: field.name, rule: 'boolean', message: `${field.name} must be a boolean` } };
    }
  } else if (field.type === 'string') {
    if (typeof v !== 'string') {
      if (coerce && (typeof v === 'number' || typeof v === 'boolean')) v = String(v);
      else return { value: v, error: { field: field.name, rule: 'string', message: `${field.name} must be a string` } };
    }
    if (field.trimFlag) v = v.trim();
    if (field.caseMode === 'lower') v = v.toLowerCase();
    if (field.caseMode === 'upper') v = v.toUpperCase();
  } else if (field.type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) {
    return { value: v, error: { field: field.name, rule: 'object', message: `${field.name} must be an object` } };
  } else if (field.type === 'array' && !Array.isArray(v)) {
    return { value: v, error: { field: field.name, rule: 'array', message: `${field.name} must be an array` } };
  }
  return { value: v };
}

/**
 * Execute one rule against a value.
 * @param {FieldSchema} field
 * @param {{rule: string, value?: *, message: string}} rule
 * @param {*} value
 * @param {object} allData
 * @returns {{field: string, rule: string, message: string}|null}
 */
function checkRule(field, rule, value, allData) {
  const fail = (ruleName, message) => ({ field: field.name, rule: ruleName, message: field.baseMessage || message });
  switch (rule.rule) {
    case 'min': {
      if (typeof value === 'number') return value >= rule.value ? null : fail('min', `${field.name} must be at least ${rule.value}`);
      const len = typeof value === 'string' || Array.isArray(value) ? value.length : String(value ?? '').length;
      return len >= rule.value ? null : fail('min', `${field.name} must be at least ${rule.value} characters`);
    }
    case 'max': {
      if (typeof value === 'number') return value <= rule.value ? null : fail('max', `${field.name} must be at most ${rule.value}`);
      const len = typeof value === 'string' || Array.isArray(value) ? value.length : String(value ?? '').length;
      return len <= rule.value ? null : fail('max', `${field.name} must be at most ${rule.value} characters`);
    }
    case 'length': {
      const [min, max] = rule.value;
      const len = Array.isArray(value) ? value.length : String(value ?? '').length;
      return len >= min && len <= max ? null : fail('length', rule.message);
    }
    case 'email':
      return EMAIL_RE.test(String(value)) ? null : fail('email', rule.message);
    case 'url': {
      try {
        const parsed = new URL(String(value));
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? null : fail('url', rule.message);
      } catch {
        return fail('url', rule.message);
      }
    }
    case 'regex':
      return rule.value.test(String(value)) ? null : fail('regex', rule.message);
    case 'oneOf':
      return rule.value.includes(value) ? null : fail('oneOf', rule.message);
    case 'custom': {
      try {
        const verdict = rule.value(value, allData);
        if (verdict === true || verdict === undefined || verdict === null) return null;
        if (typeof verdict === 'object') {
          return verdict.ok ? null : fail('custom', verdict.message || rule.message);
        }
        return fail('custom', rule.message);
      } catch (err) {
        return fail('custom', err instanceof Error ? err.message : rule.message);
      }
    }
    default:
      return null;
  }
}

/**
 * Middleware validating `ctx.req.body()` (or the query) against a schema.
 * On success the cleaned values land in `ctx.data`; on failure a 422
 * {@link ValidationError} is thrown with structured details.
 *
 * @param {Schema} schema
 * @param {object} [options]
 * @param {'body'|'query'} [options.source='body']
 * @param {boolean} [options.coerce=true]
 * @param {boolean} [options.stripUnknown=true]
 * @returns {(ctx: import('./webcraft.js').Context, next: function(): Promise<void>) => Promise<void>}
 */
export function validate(schema, options = {}) {
  if (!(schema instanceof Schema)) throw new TypeError('validate() requires a Schema instance');
  const source = options.source || 'body';
  const coerce = options.coerce !== false;
  const stripUnknown = options.stripUnknown !== false;

  return async function validationMiddleware(ctx, next) {
    const input = source === 'query' ? ctx.req.query : await ctx.req.body();
    const result = schema.validate(input, { coerce, stripUnknown });
    if (!result.ok) throw new ValidationError(result.errors);
    ctx.data = result.data;
    return next();
  };
}

/** Alias kept for discoverability: `validateBody(schema)` === `validate(schema)`. */
export const validateBody = (schema, options = {}) => validate(schema, { ...options, source: 'body' });

/** Validate the parsed query string instead of the body. */
export const validateQuery = (schema, options = {}) => validate(schema, { ...options, source: 'query' });

/**
 * Standalone e-mail checker (used by the FieldSchema rule as well).
 * @param {string} value
 * @returns {boolean}
 */
export function isEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value);
}

/**
 * Standalone URL checker.
 * @param {string} value
 * @returns {boolean}
 */
export function isUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
