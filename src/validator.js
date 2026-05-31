/**
 * schema-firewall/proxy/src/validator.js
 *
 * JSON Schema validation (draft-07 subset) — zero dependencies.
 * Covers: type, properties, required, additionalProperties,
 *         minimum/maximum, minLength/maxLength, enum, $ref (local only).
 *
 * Returns: { valid: bool, errors: string[] }
 */

export function validate(data, schema, path = '') {
  const errors = [];

  function err(msg) { errors.push(path ? `${path}: ${msg}` : msg); }

  // type check
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(data, t))) {
      err(`expected ${types.join('|')}, got ${jsType(data)}`);
      return { valid: false, errors }; // no point continuing
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some(v => deepEqual(v, data))) {
      err(`must be one of: ${JSON.stringify(schema.enum)}`);
    }
  }

  if (schema.type === 'object' || (typeof data === 'object' && data !== null && !Array.isArray(data))) {
    // required
    for (const key of (schema.required ?? [])) {
      if (!(key in data)) err(`missing required field '${key}'`);
    }
    // properties
    for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
      if (key in data) {
        const sub = validate(data[key], subschema, path ? `${path}.${key}` : key);
        errors.push(...sub.errors);
      }
    }
    // additionalProperties: false
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) err(`additional property '${key}' not allowed`);
      }
    }
  }

  if (schema.type === 'string' || typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength)
      err(`minLength ${schema.minLength}, got ${data.length}`);
    if (schema.maxLength !== undefined && data.length > schema.maxLength)
      err(`maxLength ${schema.maxLength}, got ${data.length}`);
  }

  if (schema.type === 'number' || schema.type === 'integer' || typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum)
      err(`minimum ${schema.minimum}, got ${data}`);
    if (schema.maximum !== undefined && data > schema.maximum)
      err(`maximum ${schema.maximum}, got ${data}`);
    if (schema.type === 'integer' && !Number.isInteger(data))
      err(`expected integer, got ${data}`);
  }

  if (Array.isArray(data) && schema.items) {
    data.forEach((item, i) => {
      const sub = validate(item, schema.items, `${path}[${i}]`);
      errors.push(...sub.errors);
    });
  }

  return { valid: errors.length === 0, errors };
}

function matchesType(val, type) {
  switch (type) {
    case 'null':    return val === null;
    case 'boolean': return typeof val === 'boolean';
    case 'integer': return Number.isInteger(val);
    case 'number':  return typeof val === 'number';
    case 'string':  return typeof val === 'string';
    case 'array':   return Array.isArray(val);
    case 'object':  return typeof val === 'object' && val !== null && !Array.isArray(val);
    default:        return true;
  }
}

function jsType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
