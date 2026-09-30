# Security

The runtime configuration file is intentionally ignored by `.gitignore`:

```text
plugins_configs/PushoverWatchdog.json
PushoverWatchdog.json
```

Use `PushoverWatchdog.example.json` as a template and keep the real config only on the FM-DX Webserver machine.

If you find a security issue, report it privately to the repository owner instead of opening a public issue with exploit details.

## Plugin WebSocket trust boundary

FM-DX Webserver's shared `/data_plugins` transport may rebroadcast client-originated plugin messages. Pushover Watchdog therefore treats all backend responses as administrator-only, refreshes the live FM-DX session before privileged actions, never sends notification credentials to the browser, and authenticates backend-to-frontend responses with a per-admin-connection random channel token. Keep these checks intact when adding new plugin message types.
