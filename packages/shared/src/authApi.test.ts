import { describe, expect, it } from 'vitest';
import {
  LOGIN_MESSAGES,
  LOGIN_PASSWORD_MAX_LENGTH,
  loginRequestSchema,
  meResponseSchema,
  sessionPayloadSchema,
  sessionUserSchema,
  type LoginResponse,
} from './authApi.ts';

describe('sessionUserSchema', () => {
  it('accepts the collector', () => {
    expect(sessionUserSchema.parse({ sub: 'collector' })).toEqual({ sub: 'collector' });
  });

  it('rejects any other subject', () => {
    expect(sessionUserSchema.safeParse({ sub: 'admin' }).success).toBe(false);
    expect(sessionUserSchema.safeParse({}).success).toBe(false);
  });
});

describe('sessionPayloadSchema', () => {
  const payload = { sub: 'collector', iat: 1_790_000_000, exp: 1_797_776_000 };

  it('accepts a payload with whole-second issue and expiry times', () => {
    expect(sessionPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('rejects fractional or string times', () => {
    expect(sessionPayloadSchema.safeParse({ ...payload, iat: 1.5 }).success).toBe(false);
    expect(sessionPayloadSchema.safeParse({ ...payload, exp: '1797776000' }).success).toBe(false);
  });

  it('rejects a payload without an expiry or with another subject', () => {
    expect(sessionPayloadSchema.safeParse({ sub: 'collector', iat: 1 }).success).toBe(false);
    expect(sessionPayloadSchema.safeParse({ ...payload, sub: 'customer' }).success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('accepts a sentence password exactly as typed, spaces included', () => {
    const body = { password: ' ארבע מילים ארוכות מאוד ' };
    expect(loginRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects an empty password', () => {
    expect(loginRequestSchema.safeParse({ password: '' }).success).toBe(false);
  });

  it('rejects a missing or non-string password', () => {
    expect(loginRequestSchema.safeParse({}).success).toBe(false);
    expect(loginRequestSchema.safeParse({ password: 1234 }).success).toBe(false);
    expect(loginRequestSchema.safeParse(null).success).toBe(false);
  });

  it(`accepts ${LOGIN_PASSWORD_MAX_LENGTH} characters and rejects one more`, () => {
    const longest = 'א'.repeat(LOGIN_PASSWORD_MAX_LENGTH);
    expect(loginRequestSchema.safeParse({ password: longest }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: `${longest}א` }).success).toBe(false);
  });
});

describe('meResponseSchema', () => {
  it('parses the body of a login or of GET /api/auth/me', () => {
    const body: LoginResponse = { user: { sub: 'collector' } };
    expect(meResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a body without a user', () => {
    expect(meResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('LOGIN_MESSAGES', () => {
  it('has a plain Hebrew sentence for every message', () => {
    for (const message of Object.values(LOGIN_MESSAGES)) {
      expect(message).toMatch(/[֐-׿]/);
      expect(message.endsWith('.')).toBe(true);
    }
  });
});
