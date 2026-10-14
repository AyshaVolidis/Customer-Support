// Unit tests for parseChatRequest. Shape only - G9 rules are tested elsewhere.

import { describe, expect, it } from 'vitest';

// Relative import on purpose: the "@/*" alias is a tsconfig path that Vitest
// does not resolve without extra config.
import { parseChatRequest } from '../../src/lib/chatRequest';

describe('parseChatRequest - valid bodies', () => {
  it('accepts a sessionId and a message', () => {
    const result = parseChatRequest({ sessionId: 'session-a', message: 'where is my order?' });

    expect(result).toEqual({
      ok: true,
      data: { sessionId: 'session-a', message: 'where is my order?' },
    });
  });

  it('accepts a sessionId of exactly 100 characters', () => {
    const result = parseChatRequest({ sessionId: 'a'.repeat(100), message: 'hi' });

    expect(result.ok).toBe(true);
  });

  it('drops unknown extra fields', () => {
    const result = parseChatRequest({
      sessionId: 'session-a',
      message: 'hi',
      customerId: 'cust_999',
      isAdmin: true,
    });

    expect(result).toEqual({ ok: true, data: { sessionId: 'session-a', message: 'hi' } });
  });
});

describe('parseChatRequest - G9 rules are NOT applied here', () => {
  it('accepts an empty message - emptiness is gate G9', () => {
    const result = parseChatRequest({ sessionId: 'session-a', message: '' });

    expect(result.ok).toBe(true);
  });

  it('accepts a whitespace-only message', () => {
    const result = parseChatRequest({ sessionId: 'session-a', message: '   ' });

    expect(result.ok).toBe(true);
  });

  it('accepts a 501-character message - length is gate G9', () => {
    const result = parseChatRequest({ sessionId: 'session-a', message: 'x'.repeat(501) });

    expect(result.ok).toBe(true);
  });
});

describe('parseChatRequest - invalid bodies', () => {
  it('rejects a missing sessionId', () => {
    const result = parseChatRequest({ message: 'hi' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toContain('sessionId');
  });

  it('rejects a missing message', () => {
    const result = parseChatRequest({ sessionId: 'session-a' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toContain('message');
  });

  it('rejects an empty sessionId', () => {
    const result = parseChatRequest({ sessionId: '', message: 'hi' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toContain('sessionId');
  });

  it('rejects a sessionId of 101 characters', () => {
    const result = parseChatRequest({ sessionId: 'a'.repeat(101), message: 'hi' });

    expect(result.ok).toBe(false);
  });

  it('rejects non-string fields', () => {
    expect(parseChatRequest({ sessionId: 1, message: 'hi' }).ok).toBe(false);
    expect(parseChatRequest({ sessionId: 'session-a', message: 42 }).ok).toBe(false);
    expect(parseChatRequest({ sessionId: 'session-a', message: null }).ok).toBe(false);
    expect(parseChatRequest({ sessionId: ['a'], message: 'hi' }).ok).toBe(false);
  });

  it('rejects a body that is not an object', () => {
    expect(parseChatRequest(null).ok).toBe(false);
    expect(parseChatRequest(undefined).ok).toBe(false);
    expect(parseChatRequest('hello').ok).toBe(false);
    expect(parseChatRequest(42).ok).toBe(false);
    expect(parseChatRequest([]).ok).toBe(false);
  });

  it('rejects an empty object and says what is missing', () => {
    const result = parseChatRequest({});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toContain('sessionId');
    expect(result.error).toContain('message');
  });

  it('never throws, whatever it is given', () => {
    const circular: Record<string, unknown> = { sessionId: 'a' };
    circular.self = circular;
    // parseChatRequest never collapse because it uses Zod's safeParse, which is designed to handle circular references.
    expect(() => parseChatRequest(circular)).not.toThrow();
    expect(() => parseChatRequest(Symbol('x'))).not.toThrow();
    expect(() => parseChatRequest(() => 'fn')).not.toThrow();
  });
});
