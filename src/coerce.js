/**
 * schema-firewall/proxy/src/coerce.js
 *
 * Attempt safe coercions on a parsed object against a JSON Schema.
 * Returns { data, coercions: string[] }.
 * Coercions are lossless only.
 */

export function coerce(data, schema, path = '') {
  const coercions = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { data, coercions };
  }

  const out = { ...data };

  // Strip extra fields if schema has additionalProperties: false
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(out)) {
      if (!allowed.has(key)) {
        delete out[key];
        coercions.push(`${path ? path + '.' : ''}${key}: extra field stripped`);
      }
    }
  }

  // Coerce field types
  for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
    if (!(key in out)) continue;
    const val = out[key];
    const fieldPath = path ? `${path}.${key}` : key;
    const target = subschema.type;

    if (target === 'integer' || target === 'number') {
      if (typeof val === 'string' && val.trim() !== '' && !isNaN(Number(val))) {
        const num = Number(val);
        if (target === 'integer' && Number.isInteger(num)) {
          out[key] = num;
          coercions.push(`${fieldPath}: coerced str→integer`);
        } else if (target === 'number') {
          out[key] = num;
          coercions.push(`${fieldPath}: coerced str→number`);
        }
      } else if (target === 'integer' && typeof val === 'number' && !Number.isInteger(val) && val === Math.trunc(val)) {
        out[key] = Math.trunc(val);
        coercions.push(`${fieldPath}: coerced float→integer (lossless)`);
      }
    }

    if (target === 'string' && typeof val !== 'string') {
      out[key] = String(val);
      coercions.push(`${fieldPath}: coerced ${typeof val}→string`);
    }

    if (target === 'boolean' && typeof val === 'string') {
      const lower = val.toLowerCase();
      if (['true', '1', 'yes'].includes(lower)) {
        out[key] = true;
        coercions.push(`${fieldPath}: coerced str→boolean (true)`);
      } else if (['false', '0', 'no'].includes(lower)) {
        out[key] = false;
        coercions.push(`${fieldPath}: coerced str→boolean (false)`);
      }
    }

    // Recurse into nested objects
    if (target === 'object' && typeof out[key] === 'object' && out[key] !== null) {
      const sub = coerce(out[key], subschema, fieldPath);
      out[key] = sub.data;
      coercions.push(...sub.coercions);
    }
  }

  return { data: out, coercions };
}
