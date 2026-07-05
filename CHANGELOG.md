# Changelog

## v1.0.2 - 2026-07-05

- Added optional **RDS group stream monitoring** based on FM-DX Webserver’s local raw `/rds` WebSocket. The plugin now detects when a previously active stream of usable RDS groups suddenly stops.
- Added a configurable group-stream loss timer and an optional carrier requirement in the FM Monitor panel and `PushoverWatchdog.json`.
- The detector arms only after three usable RDS groups have been received on the current target frequency, preventing false alerts on stations that never provided group traffic.
- A usable group requires a valid RDS block B, which contains the group type/version. This matches the practical operator view in RDS Expert and ignores malformed or unreadable group frames.
- Added `rdsGroupsMissing` alerts and recovery handling, including the last usable group type in notifications and live status.
- Added bounded, loopback-only `/rds` WebSocket handling with input-size limits, strict frame validation, reconnect cleanup and no alerting when the local raw-RDS socket itself is unavailable.

## v1.0.1 - 2026-06-02

- Added optional **RadioText logging** in the admin panel, with a dedicated top-panel log button and an admin-only RadioText history viewer.
- Added configurable **Telegram Bot** notifications with independent enable/disable control and test action.
- Added configurable **Zabbix sender / trapper** delivery with independent enable/disable control and test action.
- Added per-channel notification enable switches so Pushover, Telegram and Zabbix can be used independently or together.
- Added receiver settings applied after watchdog tune/retune: FM bandwidth selection including **AUTO**, and cEQ/iMS choices for keep current, enabled or disabled.
- Updated `PushoverWatchdog.example.json` with the new notification, RadioText and receiver-option settings.
- Fixed a backend regression that could raise an error when **RadioText logging** was enabled or disabled after per-sequence A/B deduplication was introduced.
- Hardened administration access: settings, test actions, live status and RadioText history are now delivered only to administrator-authenticated plugin sessions.
- Prevented Pushover and Telegram credentials from being sent through FM-DX Webserver's shared plugin WebSocket; the admin panel preserves server-side credentials, which must now be entered directly in `plugins_configs/PushoverWatchdog.json`.
- Added conservative storage hardening: private POSIX permissions (`0600` where supported), exclusive atomic temporary files, configuration/state/log size safeguards and a bounded RadioText in-memory history.
- Added backend and frontend hot-reload cleanup for WebSocket/listener/DOM handlers, plus bounded stereo-history samples, preventing gradual memory/listener accumulation on long-running or repeatedly reloaded installations.
- Normalized every boolean configuration switch loaded from JSON, so values such as `"false"` or `"0"` cannot be misinterpreted as enabled.
- Prevented a valid Pushover/Telegram token edited directly in the server JSON file from being overwritten by an almost simultaneous panel save before hot-reload completes.
- Hardened normal RadioText append writes against POSIX symbolic-link redirection without replacing the efficient append-based logging path.
- Reduced RadioText history paging memory/CPU overhead by reading requested pages backwards from the already ordered in-memory retention list instead of copying and sorting the full retained history.
- Detached live audio analysis while monitoring is disabled and completed missing abort/close handling for Pushover, Telegram and Zabbix requests, preventing avoidable retained resources on interrupted deliveries.
- Added a browser-side admin-session guard that closes the plugin WebSocket and clears the admin UI when the current page is no longer authenticated as administrator.
- Fixed a GitHub CodeQL client-side XSS alert in the live status renderer by replacing dynamic `innerHTML` rendering with DOM text nodes, and rendered RadioText log rows with `textContent` as additional defense-in-depth.

## 2026-05-26 - Signal conversion offset fix

- Updated dBf to dBµV conversion offset from `10.875` to `11.25`, matching TEF firmware and FM-DX Webserver.
- Updated dBf to dBm conversion offset from `119.75` to `120`, matching TEF firmware and FM-DX Webserver.
- Updated the admin interface help text for signal-unit monitoring to reflect the corrected conversion offsets.

## v1.0.0

Current public release by Play Radio Constanta.

Included functionality:

- Pushover alerts for signal below threshold / white noise.
- Pushover alerts for blank / no modulation.
- Pushover alerts for missing valid RDS identity.
- Pushover alerts for stereo indicator instability.
- Optional recovery notifications.
- Hot-reload of `plugins_configs/PushoverWatchdog.json`.
- Configurable monitored frequencies.
- Configurable forced retune grace interval.
- dBµV / dBf / dBm signal threshold support.
- Admin/login protected FM Monitor panel.
- Runtime cleanup protections to avoid duplicate timers, duplicate WebSocket handlers and audio listener leaks.
- Conservative security hardening for config WebSocket handling and Pushover payload limits.
