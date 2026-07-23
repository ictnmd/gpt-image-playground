import { API_KEYS_STORAGE_KEY, normalizeApiKeys, parseApiKeyText, parseStoredApiKeys } from './api-key-utils';
import { describe, expect, it } from 'vitest';

describe('API key utilities', () => {
    it('normalizes keys while preserving first-seen order', () => {
        expect(normalizeApiKeys([' first ', '', 'second', 'first', ' second '])).toEqual(['first', 'second']);
    });

    it('parses one key per textarea line', () => {
        expect(parseApiKeyText('first\r\nsecond\n\n first ')).toEqual(['first', 'second']);
    });

    it('accepts only a stored JSON string array', () => {
        expect(parseStoredApiKeys(JSON.stringify([' first ', 'second']))).toEqual(['first', 'second']);
        expect(parseStoredApiKeys('not-json')).toEqual([]);
        expect(parseStoredApiKeys(JSON.stringify({ key: 'first' }))).toEqual([]);
        expect(parseStoredApiKeys(JSON.stringify(['first', 2]))).toEqual([]);
    });

    it('uses a namespaced storage key', () => {
        expect(API_KEYS_STORAGE_KEY).toBe('gptImagePlaygroundApiKeys');
    });
});
