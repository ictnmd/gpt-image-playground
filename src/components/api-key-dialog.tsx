'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MAX_API_KEYS, MAX_API_KEY_LENGTH, parseApiKeyText } from '@/lib/api-key-utils';
import { Eye, EyeOff } from 'lucide-react';
import * as React from 'react';

type ApiKeyDialogProps = {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    initialKeys: string[];
    canDismiss: boolean;
    onSave: (keys: string[], persist: boolean) => void;
};

export function ApiKeyDialog({ isOpen, onOpenChange, initialKeys, canDismiss, onSave }: ApiKeyDialogProps) {
    const [keyText, setKeyText] = React.useState(() => initialKeys.join('\n'));
    const [persist, setPersist] = React.useState(true);
    const [showKeys, setShowKeys] = React.useState(false);
    const [validationError, setValidationError] = React.useState<string | null>(null);

    const handleDialogOpen = () => {
        setKeyText(initialKeys.join('\n'));
        setValidationError(null);
        setShowKeys(false);
    };

    const handleOpenChange = (open: boolean) => {
        if (!open && !canDismiss) return;
        onOpenChange(open);
    };

    const handleSave = () => {
        const keys = parseApiKeyText(keyText);
        if (keys.length === 0) {
            setValidationError('Enter at least one API key.');
            return;
        }
        if (keys.length > MAX_API_KEYS || keys.some((key) => key.length > MAX_API_KEY_LENGTH)) {
            setValidationError('API key configuration exceeds the supported limits.');
            return;
        }

        onSave(keys, persist);
        onOpenChange(false);
    };

    return (
        <Dialog open={isOpen} onOpenChange={handleOpenChange}>
            <DialogContent
                className='border-white/20 bg-black text-white sm:max-w-[520px]'
                onOpenAutoFocus={handleDialogOpen}
                onEscapeKeyDown={(event) => {
                    if (!canDismiss) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                    if (!canDismiss) event.preventDefault();
                }}>
                <DialogHeader>
                    <DialogTitle>Configure API Keys</DialogTitle>
                    <DialogDescription className='text-white/60'>
                        Enter one OpenAI-compatible API key per line. Keys are tried from top to bottom.
                    </DialogDescription>
                </DialogHeader>
                <div className='space-y-4 py-2'>
                    <div className='space-y-2'>
                        <div className='flex items-center justify-between'>
                            <Label htmlFor='api-key-input'>OpenAI API keys</Label>
                            <Button
                                type='button'
                                variant='ghost'
                                size='sm'
                                aria-label={showKeys ? 'Hide API keys' : 'Show API keys'}
                                onClick={() => setShowKeys((current) => !current)}>
                                {showKeys ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                            </Button>
                        </div>
                        <Textarea
                            id='api-key-input'
                            aria-label='OpenAI API keys'
                            value={keyText}
                            onChange={(event) => {
                                setKeyText(event.target.value);
                                setValidationError(null);
                            }}
                            rows={6}
                            autoComplete='off'
                            spellCheck={false}
                            className={
                                showKeys
                                    ? 'border-white/20 bg-black font-mono text-white'
                                    : 'border-white/20 bg-black font-mono text-white [-webkit-text-security:disc]'
                            }
                        />
                    </div>
                    <div className='flex items-center gap-2'>
                        <Checkbox
                            id='persist-api-keys'
                            checked={persist}
                            onCheckedChange={(checked) => setPersist(checked === true)}
                        />
                        <Label htmlFor='persist-api-keys'>Save in this browser</Label>
                    </div>
                    <Alert className='border-amber-500/30 bg-amber-950/20 text-amber-200'>
                        <AlertDescription>
                            Browser storage can be read if this application is compromised. Use HTTPS outside localhost.
                        </AlertDescription>
                    </Alert>
                    {validationError && <p className='text-sm text-red-400'>{validationError}</p>}
                </div>
                <DialogFooter>
                    <Button type='button' onClick={handleSave} aria-label='Save API keys'>
                        Save API keys
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
