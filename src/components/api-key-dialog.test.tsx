import { ApiKeyDialog } from './api-key-dialog';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

describe('ApiKeyDialog', () => {
    it('normalizes and saves one key per line with persistence enabled by default', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<ApiKeyDialog isOpen onOpenChange={vi.fn()} initialKeys={[]} canDismiss={false} onSave={onSave} />);

        await user.type(screen.getByLabelText('OpenAI API keys'), ' first{enter}second{enter}first ');
        await user.click(screen.getByRole('button', { name: 'Save API keys' }));

        expect(onSave).toHaveBeenCalledWith(['first', 'second'], true);
    });

    it('keeps the required dialog open for empty input', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<ApiKeyDialog isOpen onOpenChange={vi.fn()} initialKeys={[]} canDismiss={false} onSave={onSave} />);

        await user.click(screen.getByRole('button', { name: 'Save API keys' }));

        expect(screen.getByText('Enter at least one API key.')).toBeInTheDocument();
        expect(onSave).not.toHaveBeenCalled();
    });

    it('does not allow a required dialog to close', () => {
        const onOpenChange = vi.fn();
        render(
            <ApiKeyDialog isOpen onOpenChange={onOpenChange} initialKeys={[]} canDismiss={false} onSave={vi.fn()} />
        );

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('toggles masked key visibility', async () => {
        const user = userEvent.setup();
        render(<ApiKeyDialog isOpen onOpenChange={vi.fn()} initialKeys={['secret-key']} canDismiss onSave={vi.fn()} />);

        const textarea = screen.getByLabelText('OpenAI API keys');
        expect(textarea).toHaveClass('[-webkit-text-security:disc]');
        await user.click(screen.getByRole('button', { name: 'Show API keys' }));
        expect(textarea).not.toHaveClass('[-webkit-text-security:disc]');
    });
});
