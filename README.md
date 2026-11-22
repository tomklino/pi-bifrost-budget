# pi-bifrost-budget

A Pi extension that displays the current Bifrost one-day virtual-key budget in the status bar.

## Requirements

- Pi coding agent 1.6 or later
- A Bifrost provider with an HTTPS API endpoint
- A virtual key configured either as an `X-Bf-Vk` request header or as a bearer API key beginning with `sk-bf-`. Pi resolves the credentials for the active model; no duplicate key or header is needed.

## Usage

Install the package with:

```bash
pi install npm:pi-bifrost-budget
```

The extension displays usage and the effective daily limit in the status bar, for example:

```text
Bifrost 12.34$/100.00$
```

The status refreshes when a session starts, after model selection, after an agent run, and every 60 seconds. Run `/bifrost-budget` to refresh manually.

The extension sends the virtual key only to the active model's HTTPS quota endpoint and does not follow redirects. It shows a warning when the lookup fails and hides the budget on unrelated providers.

## Tests

Run `npm test` with Node.js 24.
