import { describe, expect, it, vi } from 'vitest';

import {
    ApiKeyPayloadError,
    ApiKeysExhaustedError,
    isRetryableApiKeyError,
    parseApiKeyPayload,
    redactApiKeys,
    withApiKeyFallback
} from './api-key-fallback';

function statusError(status: number): Error & { status: number } {
    return Object.assign(new Error(`upstream ${status}`), { status });
}

describe('parseApiKeyPayload', () => {
    it('normalizes a valid ordered key list', () => {
        expect(parseApiKeyPayload(JSON.stringify([' first ', 'second', 'first']))).toEqual(['first', 'second']);
    });

    it('rejects a missing payload as unauthorized', () => {
        expect(() => parseApiKeyPayload(null)).toThrowError(ApiKeyPayloadError);
        try {
            parseApiKeyPayload(null);
        } catch (error) {
            expect(error).toMatchObject({ status: 401, code: 'API_KEYS_REQUIRED' });
        }
    });

    it('rejects malformed and empty payloads', () => {
        expect(() => parseApiKeyPayload('not-json')).toThrowError(ApiKeyPayloadError);
        expect(() => parseApiKeyPayload(JSON.stringify([]))).toThrowError(ApiKeyPayloadError);
        expect(() => parseApiKeyPayload(JSON.stringify(['', '  ']))).toThrowError(ApiKeyPayloadError);
        expect(() => parseApiKeyPayload(JSON.stringify(['valid', 2]))).toThrowError(ApiKeyPayloadError);
    });

    it('rejects excessive keys and oversized values', () => {
        const excessive = Array.from({ length: 21 }, (_, index) => `key-${index}`);
        expect(() => parseApiKeyPayload(JSON.stringify(excessive))).toThrowError(ApiKeyPayloadError);
        expect(() => parseApiKeyPayload(JSON.stringify(['x'.repeat(513)]))).toThrowError(ApiKeyPayloadError);
    });
});

describe('isRetryableApiKeyError', () => {
    it.each([401, 403, 429, 500, 503])('retries HTTP %s', (status) => {
        expect(isRetryableApiKeyError(statusError(status))).toBe(true);
    });

    it.each([400, 404, 422])('does not retry HTTP %s', (status) => {
        expect(isRetryableApiKeyError(statusError(status))).toBe(false);
    });

    it('retries recognized connection errors only', () => {
        const connectionError = new Error('connection failed');
        connectionError.name = 'APIConnectionError';
        expect(isRetryableApiKeyError(connectionError)).toBe(true);
        expect(isRetryableApiKeyError(new Error('programming failure'))).toBe(false);
    });
});

describe('withApiKeyFallback', () => {
    it('tries keys in order and stops after success', async () => {
        const attempt = vi.fn(async (key: string) => {
            if (key !== 'third') throw statusError(429);
            return 'ok';
        });

        await expect(withApiKeyFallback(['first', 'second', 'third'], attempt)).resolves.toBe('ok');
        expect(attempt.mock.calls.map(([key]) => key)).toEqual(['first', 'second', 'third']);
    });

    it('stops immediately for a non-retryable error', async () => {
        const failure = statusError(400);
        const attempt = vi.fn(async () => {
            throw failure;
        });

        await expect(withApiKeyFallback(['first', 'second'], attempt)).rejects.toBe(failure);
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('throws a sanitized exhaustion error after the final retryable failure', async () => {
        const attempt = vi.fn(async () => {
            throw statusError(429);
        });

        await expect(withApiKeyFallback(['first', 'second'], attempt)).rejects.toMatchObject({
            name: 'ApiKeysExhaustedError',
            message: 'All configured API keys failed.',
            status: 429
        } satisfies Partial<ApiKeysExhaustedError>);
        expect(attempt).toHaveBeenCalledTimes(2);
    });
});

describe('redactApiKeys', () => {
    it('removes complete keys from an upstream error message', () => {
        expect(redactApiKeys('Authorization failed for secret-key', ['secret-key'])).toBe(
            'Authorization failed for [REDACTED]'
        );
    });
});
