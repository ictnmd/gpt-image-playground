# User-Provided API Key Fallback Design

## Goal

Require every user to provide one or more OpenAI API keys through the application UI. The server must try the keys in order when an eligible failure occurs while continuing to use `OPENAI_API_BASE_URL` from the server environment.

The server-side `OPENAI_API_KEY` is not used as a fallback.

## User Experience

- When the application loads without configured keys, it immediately opens an API key dialog.
- The dialog contains a textarea with one API key per line.
- The textarea is masked by default and provides a show or hide control.
- Blank lines are ignored and duplicate keys are removed while preserving the first occurrence.
- A **Save in this browser** checkbox is enabled by default.
- When enabled, normalized keys are stored in `localStorage`. When disabled, keys exist only in React state for the current tab.
- Saving with the checkbox disabled removes any previously persisted key list.
- The dialog cannot be dismissed unless at least one valid key is available.
- A key configuration control on both generation and editing forms reopens the dialog so users can replace or remove keys.
- The dialog warns that browser storage can be exposed if the application is compromised by cross-site scripting.

The existing `APP_PASSWORD` flow remains independent. The password controls access to the application, while the user-provided API keys authorize OpenAI-compatible API requests.

## Client Data Flow

The page owns the active normalized key list and the persistence preference.

On startup, it reads the saved list from `localStorage`. If no valid keys are found, it opens the API key dialog. Generate and Edit actions are blocked until at least one key exists.

For each request, the client serializes the key list as JSON in an `apiKeys` multipart form field. Keys are never placed in URLs and are not added to history metadata, IndexedDB image records, error messages, or console logs.

## Server Validation

`POST /api/images` parses and validates `apiKeys` before invoking the OpenAI SDK:

- The value must decode to an array of strings.
- At least one key is required.
- At most 20 keys are accepted.
- Each trimmed key must contain between 1 and 512 characters.
- Empty and duplicate values are removed while preserving order.
- No `sk-` prefix is required, allowing OpenAI-compatible providers.

Invalid key payloads return HTTP 400 without echoing submitted values. Missing keys return HTTP 401 with a user-facing configuration message.

## OpenAI Client and Fallback

The module-level OpenAI client is replaced by per-attempt clients:

```ts
new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_API_BASE_URL
});
```

The server attempts keys in the order supplied by the user. It retries with the next key for:

- HTTP 401 or 403 authentication and authorization failures
- HTTP 429 rate-limit or quota failures
- HTTP 5xx upstream failures
- Network and connection failures that have no upstream HTTP status

It does not retry validation, prompt, moderation, or other HTTP 4xx failures. When every key fails, the route returns the final sanitized error and indicates that all configured keys were attempted. It never identifies or includes a key value.

Shared helper functions handle key parsing, retry classification, and ordered attempts so generation and editing use identical behavior.

## Streaming Behavior

Streaming generation and editing use the same ordered key selection.

If opening or consuming an upstream stream fails before any SSE event is forwarded to the browser, the server tries the next eligible key. Once any partial or completed image event has been sent, the server does not retry with another key. It emits a sanitized SSE error and closes the stream.

This boundary prevents duplicate image generation, duplicate charges, and mixed output from different attempts.

## Security

- Keys are handled only in browser state, optional browser `localStorage`, the request body, and short-lived server memory.
- Keys are never persisted by the server.
- Server and client logs must not include request key payloads, OpenAI authorization headers, or key fragments.
- Errors sent to the browser are sanitized before display.
- The UI advises users to run the application over HTTPS when it is not local.
- Key count and length limits constrain payload abuse.

## Components and Boundaries

- `ApiKeyDialog`: collects, masks, normalizes, and returns key text plus the persistence choice.
- API key client utility: parses stored values and normalizes textarea input without depending on React.
- Page state: loads, saves, clears, and attaches active keys to image requests.
- API key server utility: validates the multipart payload, classifies retryable errors, and performs ordered attempts.
- Images route: retains request parsing, image generation or editing, streaming, and storage responsibilities while delegating key behavior to the utility.

## Error Handling

- Empty dialog submission: keep the dialog open and show an inline validation message.
- Corrupt browser storage: remove the stored value and reopen the dialog.
- Invalid server payload: return HTTP 400.
- Missing key payload: return HTTP 401.
- All keys exhausted: return a sanitized final error with an exhaustion message.
- Streaming failure after output begins: send one SSE error event and close the stream without retrying.

## Testing and Validation

Unit tests cover:

- Trimming blank lines and preserving key order
- Deduplicating keys
- Rejecting empty, malformed, oversized, and excessive key lists
- Classifying eligible and ineligible fallback errors
- Trying keys in order
- Stopping after success
- Returning the final failure after exhaustion
- Not retrying a streaming attempt after output begins

Project validation runs the unit tests, ESLint, and the production build, which includes TypeScript validation.

## Out of Scope

- User-configurable API base URLs
- Server-side key storage
- Encryption or account synchronization of browser-stored keys
- Key health dashboards, usage balancing, or random key selection
- Falling back to `OPENAI_API_KEY`
