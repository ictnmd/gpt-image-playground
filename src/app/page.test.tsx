import HomePage from './page';
import { API_KEYS_STORAGE_KEY } from '@/lib/api-key-utils';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/api-key-dialog', () => ({
    ApiKeyDialog: ({
        isOpen,
        onOpenChange,
        initialKeys,
        onSave
    }: {
        isOpen: boolean;
        onOpenChange: (open: boolean) => void;
        initialKeys: string[];
        onSave: (keys: string[], persist: boolean) => void;
    }) =>
        isOpen ? (
            <div role='dialog' aria-label='API key configuration'>
                <span>{initialKeys.length} configured keys</span>
                <button
                    onClick={() => {
                        onSave(['persisted-test-key'], true);
                        onOpenChange(false);
                    }}>
                    Save persistent keys
                </button>
                <button
                    onClick={() => {
                        onSave(['session-test-key'], false);
                        onOpenChange(false);
                    }}>
                    Save session keys
                </button>
            </div>
        ) : null
}));

vi.mock('@/components/password-dialog', () => ({
    PasswordDialog: ({ isOpen }: { isOpen: boolean }) =>
        isOpen ? <div role='dialog' aria-label='Password configuration' /> : null
}));

vi.mock('@/components/generation-form', () => ({
    GenerationForm: ({
        onSubmit,
        hasApiKeys,
        onOpenApiKeyDialog,
        isPasswordRequiredByBackend
    }: {
        onSubmit: (data: Record<string, unknown>) => void;
        hasApiKeys: boolean;
        onOpenApiKeyDialog: () => void;
        isPasswordRequiredByBackend: boolean | null;
    }) => (
        <div>
            <span aria-label='Generation keys configured'>{String(hasApiKeys)}</span>
            <span aria-label='Password required'>{String(isPasswordRequiredByBackend)}</span>
            <button aria-label='Configure generation API keys' onClick={onOpenApiKeyDialog}>
                Configure
            </button>
            <button
                onClick={() =>
                    onSubmit({
                        prompt: 'test prompt',
                        n: 1,
                        size: 'auto',
                        customWidth: 1024,
                        customHeight: 1024,
                        quality: 'auto',
                        output_format: 'png',
                        background: 'auto',
                        moderation: 'auto',
                        model: 'gpt-image-2'
                    })
                }>
                Generate test image
            </button>
        </div>
    )
}));

vi.mock('@/components/editing-form', () => ({
    EditingForm: ({ hasApiKeys, onOpenApiKeyDialog }: { hasApiKeys: boolean; onOpenApiKeyDialog: () => void }) => (
        <div>
            <span aria-label='Editing keys configured'>{String(hasApiKeys)}</span>
            <button aria-label='Configure editing API keys' onClick={onOpenApiKeyDialog}>
                Configure
            </button>
        </div>
    )
}));

vi.mock('@/components/history-panel', () => ({
    HistoryPanel: () => null
}));

vi.mock('@/components/image-output', () => ({
    ImageOutput: () => null
}));

vi.mock('dexie-react-hooks', () => ({
    useLiveQuery: () => []
}));

vi.mock('@/lib/cost-utils', () => ({
    calculateApiCost: () => null
}));

type JsonResponseOptions = {
    ok?: boolean;
    status?: number;
};

function jsonResponse(data: unknown, { ok = true, status = 200 }: JsonResponseOptions = {}) {
    return {
        ok,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: vi.fn().mockResolvedValue(data),
        body: null
    } as unknown as Response;
}

function mockFetch({
    passwordRequired = false,
    imageResponse = jsonResponse({ images: [] })
}: {
    passwordRequired?: boolean;
    imageResponse?: Response;
} = {}) {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
        if (input === '/api/auth-status') {
            return Promise.resolve(jsonResponse({ passwordRequired }));
        }
        if (input === '/api/images') {
            return Promise.resolve(imageResponse);
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('HomePage API key integration', () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('opens mandatory API key configuration on first load and exposes controls for both forms', async () => {
        render(<HomePage />);

        expect(await screen.findByRole('dialog', { name: 'API key configuration' })).toBeInTheDocument();
        expect(screen.getByLabelText('Generation keys configured')).toHaveTextContent('false');
        expect(screen.getByLabelText('Editing keys configured')).toHaveTextContent('false');
        expect(screen.getByRole('button', { name: 'Configure generation API keys' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Configure editing API keys' })).toBeInTheDocument();
    });

    it('removes corrupt stored keys and reopens configuration', async () => {
        localStorage.setItem(API_KEYS_STORAGE_KEY, '{"not":"an array"}');

        render(<HomePage />);

        expect(await screen.findByRole('dialog', { name: 'API key configuration' })).toBeInTheDocument();
        expect(localStorage.getItem(API_KEYS_STORAGE_KEY)).toBeNull();
    });

    it('stores opted-in keys and removes prior storage when persistence is disabled', async () => {
        render(<HomePage />);

        await screen.findByRole('dialog', { name: 'API key configuration' });
        fireEvent.click(screen.getByRole('button', { name: 'Save persistent keys' }));
        expect(localStorage.getItem(API_KEYS_STORAGE_KEY)).toBe(JSON.stringify(['persisted-test-key']));

        fireEvent.click(screen.getByRole('button', { name: 'Configure generation API keys' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save session keys' }));
        expect(localStorage.getItem(API_KEYS_STORAGE_KEY)).toBeNull();
    });

    it('attaches keys only to image multipart data and never copies them into history', async () => {
        const apiKey = 'request-only-secret-key';
        localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify([apiKey]));
        const fetchMock = mockFetch({
            imageResponse: jsonResponse({
                images: [{ filename: 'generated.png', output_format: 'png', path: '/generated.png' }]
            })
        });

        render(<HomePage />);

        await waitFor(() => expect(screen.getByLabelText('Generation keys configured')).toHaveTextContent('true'));
        fireEvent.click(screen.getByRole('button', { name: 'Generate test image' }));

        await waitFor(() => {
            expect(fetchMock.mock.calls.some(([input]) => input === '/api/images')).toBe(true);
        });
        const imageRequest = fetchMock.mock.calls.find(([input]) => input === '/api/images');
        const requestBody = imageRequest?.[1]?.body as FormData;
        expect(requestBody.get('apiKeys')).toBe(JSON.stringify([apiKey]));

        await waitFor(() => {
            const storedHistory = localStorage.getItem('openaiImageHistory');
            expect(storedHistory).not.toBeNull();
            expect(JSON.parse(storedHistory!)).toHaveLength(1);
        });
        expect(localStorage.getItem('openaiImageHistory')).not.toContain(apiKey);
    });

    it.each(['API_KEYS_REQUIRED', 'INVALID_API_KEYS'])('reopens key configuration for %s', async (code) => {
        localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(['configured-key']));
        mockFetch({
            imageResponse: jsonResponse({ code, error: `${code} response` }, { ok: false, status: 400 })
        });

        render(<HomePage />);

        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'API key configuration' })).not.toBeInTheDocument()
        );
        fireEvent.click(screen.getByRole('button', { name: 'Generate test image' }));

        expect(await screen.findByText(`${code} response`)).toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'API key configuration' })).toBeInTheDocument();
    });

    it('handles exhausted keys before generic password 401 logic', async () => {
        localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(['configured-key']));
        localStorage.setItem('clientPasswordHash', 'existing-password-hash');
        mockFetch({
            passwordRequired: true,
            imageResponse: jsonResponse(
                { code: 'API_KEYS_EXHAUSTED', error: 'All configured keys are exhausted.' },
                { ok: false, status: 401 }
            )
        });

        render(<HomePage />);

        await waitFor(() => expect(screen.getByLabelText('Password required')).toHaveTextContent('true'));
        fireEvent.click(screen.getByRole('button', { name: 'Generate test image' }));

        expect(await screen.findByText('All configured keys are exhausted.')).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Password configuration' })).not.toBeInTheDocument();
    });
});
