/**
 * test/validator.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validator.js';

const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    item:        { type: 'string' },
    quantity:    { type: 'integer' },
    price_cents: { type: 'integer' },
    notes:       { type: 'string' },
  },
  required: ['item', 'quantity', 'price_cents'],
  additionalProperties: false,
};

describe('validator', () => {
  it('passes a valid object', () => {
    const { valid, errors } = validate({ item: 'Widget', quantity: 3, price_cents: 1999 }, ORDER_SCHEMA);
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
  });

  it('fails on missing required field', () => {
    const { valid, errors } = validate({ item: 'Widget', quantity: 3 }, ORDER_SCHEMA);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('price_cents')));
  });

  it('fails on wrong type', () => {
    const { valid, errors } = validate({ item: 'Widget', quantity: 'three', price_cents: 100 }, ORDER_SCHEMA);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('quantity')));
  });

  it('fails on additional property', () => {
    const { valid, errors } = validate({ item: 'W', quantity: 1, price_cents: 100, extra: 'nope' }, ORDER_SCHEMA);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('extra')));
  });

  it('validates nested object', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'integer' } },
          required: ['name'],
        },
      },
      required: ['user'],
    };
    const { valid } = validate({ user: { name: 'Alice', age: 30 } }, schema);
    assert.equal(valid, true);
  });

  it('validates enum constraint', () => {
    const schema = { type: 'string', enum: ['red', 'green', 'blue'] };
    assert.equal(validate('red', schema).valid, true);
    assert.equal(validate('yellow', schema).valid, false);
  });

  it('validates minLength', () => {
    const schema = { type: 'string', minLength: 3 };
    assert.equal(validate('ab', schema).valid, false);
    assert.equal(validate('abc', schema).valid, true);
  });

  it('validates minimum/maximum', () => {
    const schema = { type: 'integer', minimum: 1, maximum: 10 };
    assert.equal(validate(0, schema).valid, false);
    assert.equal(validate(5, schema).valid, true);
    assert.equal(validate(11, schema).valid, false);
  });
});
