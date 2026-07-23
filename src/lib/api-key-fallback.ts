import { MAX_API_KEYS, MAX_API_KEY_LENGTH, normalizeApiKeys } from './api-key-utils';

type ApiKeyErrorCode = 'API_KEYS_REQUIRED' | 'INVALID_API_KEYS';

type SafeApiErrorBody = {
    error: string;
    code?: ApiKeyErrorCode | 'API_KEYS_EXHAUSTED';
};

type PrimedStream<T> = {
    first: IteratorResult<T>;
    iterator: AsyncIterator<T>;
};

export class ApiKeyPayloadError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: ApiKeyErrorCode
    ) {
        super(message);
        this.name = 'ApiKeyPayloadError';
    }
}

export class ApiKeysExhaustedError extends Error {
    constructor(readonly status: number) {
        super('All configured API keys failed.');
        this.name = 'ApiKeysExhaustedError';
    }
}

class ApiKeyAttemptError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = 'ApiKeyAttemptError';
    }
}

function getErrorStatus(error: unknown): number | undefined {
    if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
        return error.status;
    }

    return undefined;
}

function sanitizeApiKeyError(error: unknown, apiKeys: readonly string[]): ApiKeyAttemptError {
    const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : 'The API key request failed.';

    return new ApiKeyAttemptError(redactApiKeys(message, apiKeys), getErrorStatus(error));
}

export function parseApiKeyPayload(value: FormDataEntryValue | null): string[] {
    if (typeof value !== 'string') {
        throw new ApiKeyPayloadError('Configure at least one API key.', 401, 'API_KEYS_REQUIRED');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new ApiKeyPayloadError('The API key payload is invalid.', 400, 'INVALID_API_KEYS');
    }

    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new ApiKeyPayloadError('The API key payload is invalid.', 400, 'INVALID_API_KEYS');
    }
    if (parsed.length > MAX_API_KEYS) {
        throw new ApiKeyPayloadError(`Configure no more than ${MAX_API_KEYS} API keys.`, 400, 'INVALID_API_KEYS');
    }
    if (parsed.some((item) => item.trim().length > MAX_API_KEY_LENGTH)) {
        throw new ApiKeyPayloadError(
            `Each API key must contain at most ${MAX_API_KEY_LENGTH} characters.`,
            400,
            'INVALID_API_KEYS'
        );
    }

    const apiKeys = normalizeApiKeys(parsed);
    if (apiKeys.length === 0) {
        throw new ApiKeyPayloadError('Configure at least one API key.', 400, 'INVALID_API_KEYS');
    }

    return apiKeys;
}

export function isRetryableApiKeyError(error: unknown): boolean {
    const status = getErrorStatus(error);
    if (status !== undefined) {
        return status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599);
    }

    if (!(error instanceof Error)) return false;
    return ['APIConnectionError', 'APIConnectionTimeoutError', 'FetchError'].includes(error.name);
}

export async function withApiKeyFallback<T>(
    apiKeys: readonly string[],
    attempt: (apiKey: string, index: number) => Promise<T>
): Promise<T> {
    let finalStatus = 502;

    for (let index = 0; index < apiKeys.length; index++) {
        try {
            return await attempt(apiKeys[index], index);
        } catch (error) {
            if (!isRetryableApiKeyError(error)) throw sanitizeApiKeyError(error, apiKeys);
            finalStatus = getErrorStatus(error) ?? 502;
        }
    }

    throw new ApiKeysExhaustedError(finalStatus);
}

export async function openStreamWithApiKeyFallback<T>(
    apiKeys: readonly string[],
    openStream: (apiKey: string, index: number) => Promise<AsyncIterable<T>>
): Promise<AsyncIterable<T>> {
    const primed = await withApiKeyFallback<PrimedStream<T>>(apiKeys, async (apiKey, index) => {
        const stream = await openStream(apiKey, index);
        const iterator = stream[Symbol.asyncIterator]();
        try {
            const first = await iterator.next();
            return { first, iterator };
        } catch (error) {
            try {
                await iterator.return?.();
            } catch {}
            throw error;
        }
    });

    return {
        async *[Symbol.asyncIterator]() {
            let completedNaturally = primed.first.done;
            try {
                if (!primed.first.done) yield primed.first.value;

                if (!completedNaturally) {
                    let next = await primed.iterator.next();
                    while (!next.done) {
                        yield next.value;
                        next = await primed.iterator.next();
                    }
                    completedNaturally = true;
                }
            } finally {
                if (!completedNaturally) {
                    try {
                        await primed.iterator.return?.();
                    } catch {}
                }
            }
        }
    };
}

export function getSafeApiError(
    error: unknown,
    apiKeys: readonly string[]
): { status: number; body: SafeApiErrorBody } {
    if (error instanceof ApiKeyPayloadError) {
        return {
            status: error.status,
            body: { error: error.message, code: error.code }
        };
    }

    if (error instanceof ApiKeysExhaustedError) {
        return {
            status: error.status,
            body: {
                error: 'All configured API keys failed. Check the keys or try again later.',
                code: 'API_KEYS_EXHAUSTED'
            }
        };
    }

    const status = getErrorStatus(error) ?? 500;
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
    return {
        status,
        body: { error: redactApiKeys(message, apiKeys) }
    };
}

export function redactApiKeys(message: string, apiKeys: readonly string[]): string {
    return [...apiKeys]
        .sort((first, second) => second.length - first.length)
        .reduce((safeMessage, apiKey) => safeMessage.replaceAll(apiKey, '[REDACTED]'), message);
}
