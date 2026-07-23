import {
    ApiKeyPayloadError,
    ApiKeysExhaustedError,
    getSafeApiError,
    getSafeUpstreamErrorMessage,
    isRetryableApiKeyError,
    openStreamWithApiKeyFallback,
    parseApiKeyPayload,
    redactApiKeys,
    withApiKeyFallback
} from './api-key-fallback';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { describe, expect, it, vi } from 'vitest';

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
    it.each([401, 403, 429, 500, 503, 599])('retries HTTP %s', (status) => {
        expect(isRetryableApiKeyError(statusError(status))).toBe(true);
    });

    it.each([400, 404, 422, 600])('does not retry HTTP %s', (status) => {
        expect(isRetryableApiKeyError(statusError(status))).toBe(false);
    });

    it('retries actual OpenAI SDK connection errors only', () => {
        expect(isRetryableApiKeyError(new APIConnectionError({ message: 'connection failed' }))).toBe(true);
        expect(isRetryableApiKeyError(new APIConnectionTimeoutError({ message: 'request timed out' }))).toBe(true);
        expect(isRetryableApiKeyError(new Error('programming failure'))).toBe(false);
    });

    it('does not trust an arbitrary error name', () => {
        const lookalike = new Error('not an SDK connection error');
        lookalike.name = 'APIConnectionError';

        expect(isRetryableApiKeyError(lookalike)).toBe(false);
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

    it.each([
        ['connection', new APIConnectionError({ message: 'connection failed' })],
        ['timeout', new APIConnectionTimeoutError({ message: 'request timed out' })]
    ])('advances to the next key after an actual SDK %s error', async (_kind, failure) => {
        const attempt = vi.fn(async (key: string) => {
            if (key === 'first') throw failure;
            return 'ok';
        });

        await expect(withApiKeyFallback(['first', 'second'], attempt)).resolves.toBe('ok');
        expect(attempt.mock.calls.map(([key]) => key)).toEqual(['first', 'second']);
    });

    it('stops immediately and replaces a non-retryable upstream message with an allowlisted message', async () => {
        const apiKey = 'sk-sensitive-prefix-middle-suffix-fragment';
        const failure = Object.assign(
            new Error(`invalid request for ${apiKey}; masked key sk-sensitive-prefix...suffix-fragment was rejected`),
            {
                status: 400,
                request: { apiKey }
            }
        );
        const attempt = vi.fn(async () => {
            throw failure;
        });

        let thrown: unknown;
        try {
            await withApiKeyFallback([apiKey, 'second'], attempt);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).not.toBe(failure);
        expect(thrown).toMatchObject({
            message: 'The provider request failed.',
            status: 400
        });
        expect((thrown as Error).message).not.toContain(apiKey);
        expect((thrown as Error).message).not.toContain('sk-sensitive-prefix');
        expect((thrown as Error).message).not.toContain('suffix-fragment');
        expect(thrown).not.toHaveProperty('request');
        expect(thrown).not.toHaveProperty('cause');
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('throws a sanitized exhaustion error without retaining the raw final failure', async () => {
        const failure = Object.assign(new Error('rate limited for second'), {
            status: 429,
            request: { apiKey: 'second' }
        });
        const attempt = vi.fn(async () => {
            throw failure;
        });

        let thrown: unknown;
        try {
            await withApiKeyFallback(['first', 'second'], attempt);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).not.toBe(failure);
        expect(thrown).toMatchObject({
            name: 'ApiKeysExhaustedError',
            message: 'All configured API keys failed.',
            status: 429
        } satisfies Partial<ApiKeysExhaustedError>);
        expect(thrown).not.toHaveProperty('request');
        expect(thrown).not.toHaveProperty('cause');
        expect(attempt).toHaveBeenCalledTimes(2);
    });
});

describe('openStreamWithApiKeyFallback', () => {
    it('closes a failed priming iterator before trying the next key', async () => {
        const order: string[] = [];
        const cleanup = vi.fn(async () => {
            order.push('cleanup:first');
            return { done: true as const, value: undefined };
        });
        const stream = await openStreamWithApiKeyFallback(['first', 'second'], async (apiKey) => {
            order.push(`open:${apiKey}`);
            if (apiKey === 'first') {
                return {
                    [Symbol.asyncIterator]() {
                        return {
                            async next() {
                                throw statusError(503);
                            },
                            return: cleanup
                        };
                    }
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield 'completed';
                }
            };
        });

        const events: string[] = [];
        for await (const event of stream) events.push(event);

        expect(order).toEqual(['open:first', 'cleanup:first', 'open:second']);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['completed']);
    });

    it('closes the selected iterator once when the consumer breaks', async () => {
        const cleanup = vi.fn(async () => {
            throw new Error('cleanup failed');
        });
        const stream = await openStreamWithApiKeyFallback(['first'], async () => ({
            [Symbol.asyncIterator]() {
                return {
                    async next() {
                        return { done: false as const, value: 'partial' };
                    },
                    return: cleanup
                };
            }
        }));

        await expect(
            (async () => {
                for await (const event of stream) {
                    expect(event).toBe('partial');
                    break;
                }
            })()
        ).resolves.toBeUndefined();

        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('preserves a retryable priming failure when cleanup throws', async () => {
        const attempts: string[] = [];
        const cleanup = vi.fn(async () => {
            throw statusError(400);
        });
        const stream = await openStreamWithApiKeyFallback(['first', 'second'], async (apiKey) => {
            attempts.push(apiKey);
            if (apiKey === 'first') {
                return {
                    [Symbol.asyncIterator]() {
                        return {
                            async next() {
                                throw statusError(503);
                            },
                            return: cleanup
                        };
                    }
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield 'completed';
                }
            };
        });

        const events: string[] = [];
        for await (const event of stream) events.push(event);

        expect(attempts).toEqual(['first', 'second']);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['completed']);
    });

    it('does not reopen after the first event or replace an iteration failure when cleanup throws', async () => {
        const attempts: string[] = [];
        const failure = statusError(503);
        const cleanup = vi.fn(async () => {
            throw statusError(400);
        });
        const stream = await openStreamWithApiKeyFallback(['first', 'second'], async (apiKey) => {
            attempts.push(apiKey);
            return {
                [Symbol.asyncIterator]() {
                    let eventIndex = 0;
                    return {
                        async next() {
                            if (eventIndex++ === 0) return { done: false as const, value: 'partial' };
                            throw failure;
                        },
                        return: cleanup
                    };
                }
            };
        });

        const events: string[] = [];
        await expect(async () => {
            for await (const event of stream) events.push(event);
        }).rejects.toBe(failure);

        expect(events).toEqual(['partial']);
        expect(attempts).toEqual(['first']);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('does not close the selected iterator after natural completion', async () => {
        const cleanup = vi.fn(async () => ({ done: true as const, value: undefined }));
        const stream = await openStreamWithApiKeyFallback(['first'], async () => ({
            [Symbol.asyncIterator]() {
                let eventIndex = 0;
                return {
                    async next() {
                        if (eventIndex++ === 0) return { done: false as const, value: 'completed' };
                        return { done: true as const, value: undefined };
                    },
                    return: cleanup
                };
            }
        }));

        const events: string[] = [];
        for await (const event of stream) events.push(event);

        expect(events).toEqual(['completed']);
        expect(cleanup).not.toHaveBeenCalled();
    });
});

describe('getSafeUpstreamErrorMessage', () => {
    it.each([
        [statusError(401), 'The provider rejected the API key.'],
        [statusError(403), 'The provider rejected the API key.'],
        [statusError(429), 'The provider rate limit or quota was exceeded.'],
        [new APIConnectionError({ message: 'raw connection detail' }), 'Could not connect to the provider.'],
        [new APIConnectionTimeoutError({ message: 'raw timeout detail' }), 'Could not connect to the provider.'],
        [statusError(503), 'The provider is temporarily unavailable.'],
        [statusError(400), 'The provider request failed.'],
        [new Error('unknown upstream failure'), 'The provider request failed.']
    ])('maps upstream metadata to an allowlisted message', (error, expected) => {
        expect(getSafeUpstreamErrorMessage(error)).toBe(expected);
    });

    it('does not expose full or partial credential strings from upstream messages', () => {
        const apiKey = 'sk-sensitive-prefix-middle-suffix-fragment';
        const error = Object.assign(new Error(`Rejected ${apiKey}; masked sk-sensitive-prefix...suffix-fragment`), {
            status: 401
        });

        const message = getSafeUpstreamErrorMessage(error);

        expect(message).toBe('The provider rejected the API key.');
        expect(message).not.toContain(apiKey);
        expect(message).not.toContain('sk-sensitive-prefix');
        expect(message).not.toContain('suffix-fragment');
    });
});

describe('getSafeApiError', () => {
    it('returns API key payload error codes', () => {
        expect(getSafeApiError(new ApiKeyPayloadError('Configure a key.', 401, 'API_KEYS_REQUIRED'), [])).toEqual({
            status: 401,
            body: { error: 'Configure a key.', code: 'API_KEYS_REQUIRED' }
        });
    });

    it('returns a sanitized exhaustion response', () => {
        const error = new ApiKeysExhaustedError(401);

        expect(getSafeApiError(error, ['secret-key'])).toEqual({
            status: 401,
            body: {
                error: 'All configured API keys failed. Check the keys or try again later.',
                code: 'API_KEYS_EXHAUSTED'
            }
        });
    });

    it('redacts keys from non-exhaustion messages', () => {
        const error = Object.assign(new Error('Request rejected for secret-key'), { status: 400 });
        expect(getSafeApiError(error, ['secret-key'])).toEqual({
            status: 400,
            body: { error: 'Request rejected for [REDACTED]' }
        });
    });
});

describe('redactApiKeys', () => {
    it('removes complete keys from an upstream error message', () => {
        expect(redactApiKeys('Authorization failed for secret-key', ['secret-key'])).toBe(
            'Authorization failed for [REDACTED]'
        );
    });

    it('redacts overlapping keys longest-first', () => {
        expect(redactApiKeys('Authorization failed for secret-value', ['secret', 'secret-value'])).toBe(
            'Authorization failed for [REDACTED]'
        );
    });
});
