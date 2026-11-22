# @lutraman/pi-bifrost-budget

A Pi extension that displays the current Bifrost one-day virtual-key budget in the status bar.

## Requirements

- Pi coding agent
- A Bifrost provider configured in Pi's `models.json`
- The provider must define an `x-bf-vk` header, either directly or through a value stored in Pi's `auth.json`

## Usage

Install the package with:

```bash
pi install npm:@lutraman/pi-bifrost-budget
```

The extension displays usage and the effective daily limit in the status bar, for example:

```text
12.34$/100.00$
```

The status refreshes when a session starts, after model selection, after an agent run, and every 60 seconds. Run `/bifrost-budget` to refresh manually.

The extension reads the configured Bifrost connection from Pi's local configuration and sends the virtual key only to the configured Bifrost quota endpoint. Credentials are not included in this package.
