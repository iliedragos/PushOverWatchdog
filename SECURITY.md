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

## WebSocket resource limits (v1.0.6)

Each attached connection has one running plugin action and at most eight pending actions. Across this plugin runtime, at most 64 actions run and 256 actions wait. Test-notification requests remain inside the worker until their existing transport deadline finishes. Disconnect and runtime shutdown discard queued actions and settle authorization waits.

Token buckets apply before JSON parsing: per connection, a burst of 200 frames or 2 MiB, replenished over two seconds; globally, 2,000 frames or 16 MiB per second. Plugin action and connection-attachment buckets each allow a burst of 128, replenished over two seconds. At most 512 shared connections receive this plugin's handlers. At global capacity, excess plugin work/attachments are ignored; clients can retry after pressure subsides. Recognized Watchdog queue overflow terminates that socket. Generic preparse rate overflow detaches only Watchdog processing and preserves other shared listeners; a single oversized frame remains ignored as before. The admin frontend closes and reconnects its own plugin socket if authenticated initial configuration does not arrive within ten seconds, using the existing five-second reconnect delay. An unregistered connection receives no administrator channel token or plugin responses.

Before each send, the existing `bufferedAmount` plus the serialized response must fit within 256 KiB; a slow consumer exceeding this ceiling is terminated. Authentication rejection replies are limited to one per connection per five seconds, with a shared warning-log budget of one per second.

These are plugin limits, not transport-wide DDoS protection. FM-DX owns the shared WSS, frame assembly, all accepted sockets, session-store implementation, and other plugin listeners. Configure early `maxPayload`, connection/per-source admission and transport-wide output/rate limits in the host or reverse proxy. This repository cannot enforce those before the host accepts or assembles a frame. A plugin disconnect cannot cancel a session-store I/O operation already submitted to the host; its plugin continuation and timer are released, and new work is rate-limited.

Run the complete regression suite with `node --test tests/*.test.cjs` (Node.js 22 or newer). Tests execute the actual backend in a VM with isolated filesystem, clocks, and simulated FM-DX/WebSocket dependencies. They do not establish production receiver integration, network throughput, or measured heap usage.

## Administrator frontend resource limits (v1.0.7)

The browser limits all inbound plugin-socket traffic before JSON parsing and dashboard authentication checks. Each connection permits a burst of 200 frames and 2 MiB of text storage, replenished over two seconds (100 frames and 1 MiB per second). Text is charged as two bytes per UTF-16 code unit without allocating an encoded copy; this is a browser-work/storage budget, not a wire-byte measurement. Oversized and non-text frames also consume frame admission. The existing 65536-code-unit per-frame text cap and per-connection channel-token checks remain in force.

Exhausting either budget closes only the plugin-owned browser socket and suppresses queued message processing. Reconnect delays grow from 5 to 10, 20, 40 and 60 seconds and remain capped there across repeated floods. A connection that receives authenticated config, stays open for at least one minute, and closes without a flood resets the delay to five seconds. Logout/runtime shutdown clears reconnect timers. Other host/plugin sockets are not closed.

This bounds this frontend's aggregate parsing work, including invalid-token and malformed messages. Under a sustained transport flood the plugin UI may remain disconnected, and the browser/host still incurs frame delivery and assembly costs. Transport-wide admission, isolation and output limits remain the FM-DX host/reverse proxy's responsibility. The Node VM regression suite does not constitute a live-browser responsiveness or receiver integration test.
