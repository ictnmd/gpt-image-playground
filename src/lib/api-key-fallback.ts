import { MAX_API_KEYS, MAX_API_KEY_LENGTH, normalizeApiKeys } from './api-key-utils';

type ApiKeyErrorCode = 'API_KEYS_REQUIRED' | 'INVALID_API_KEYS';

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

export function redactApiKeys(message: string, apiKeys: readonly string[]): string {
    return [...apiKeys]
        .sort((first, second) => second.length - first.length)
        .reduce((safeMessage, apiKey) => safeMessage.replaceAll(apiKey, '[REDACTED]'), message);
}
