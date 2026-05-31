/**
 * test/coerce.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coerce } from '../src/coerce.js';

const SCHEMA = {
  type: 'object',
  properties: {
    item:        { type: 'string' },
    quantity:    { type: 'integer' },
    price_cents: { type: 'integer' },
    active:      { type: 'boolean' },
  },
  required: ['item', 'quantity', 'price_cents'],
  additionalProperties: false,
};

describe('coerce', () => {
  it('str→integer', () => {
    const { data, coercions } = coerce({ item: 'W', quantity: '3', price_cents: 100 }, SCHEMA);
    assert.equal(data.quantity, 3);
    assert.ok(coercions.some(c => c.includes('quantity') && c.includes('integer')));
  });

  it('strips extra fields when additionalProperties: false', () => {
    const { data, coercions } = coerce({ item: 'W', quantity: 3, price_cents: 100, junk: 'x' }, SCHEMA);
    assert.ok(!('junk' in data));
    assert.ok(coercions.some(c => c.includes('junk')));
  });

  it('str→boolean true variants', () => {
    for (const v of ['true', '1', 'yes']) {
      const { data } = coerce({ item: 'W', quantity: 1, price_cents: 1, active: v }, SCHEMA);
      assert.equal(data.active, true, `expected true for "${v}"`);
    }
  });

  it('str→boolean false variants', () => {
    for (const v of ['false', '0', 'no']) {
      const { data } = coerce({ item: 'W', quantity: 1, price_cents: 1, active: v }, SCHEMA);
      assert.equal(data.active, false, `expected false for "${v}"`);
    }
  });

  it('number→string', () => {
    const schema = { type: 'object', properties: { label: { type: 'string' } } };
    const { data } = coerce({ label: 42 }, schema);
    assert.equal(data.label, '42');
  });

  it('no coercion needed — passes through clean', () => {
    const { data, coercions } = coerce({ item: 'W', quantity: 3, price_cents: 100 }, SCHEMA);
    assert.equal(data.quantity, 3);
    assert.deepEqual(coercions, []);
  });

  it('lossless float→integer', () => {
    const { data } = coerce({ item: 'W', quantity: 3.0, price_cents: 100 }, SCHEMA);
    assert.equal(data.quantity, 3);
    assert.equal(typeof data.quantity, 'number');
  });
});
