export const API_KEYS_STORAGE_KEY = 'gptImagePlaygroundApiKeys';
export const MAX_API_KEYS = 20;
export const MAX_API_KEY_LENGTH = 512;

export function normalizeApiKeys(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const value of values) {
        const key = value.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        normalized.push(key);
    }

    return normalized;
}

export function parseApiKeyText(value: string): string[] {
    return normalizeApiKeys(value.split(/\r?\n/));
}

export function parseStoredApiKeys(value: string | null): string[] {
    if (!value) return [];

    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return [];
        return normalizeApiKeys(parsed);
    } catch {
        return [];
    }
}
