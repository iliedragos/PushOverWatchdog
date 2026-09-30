# Changelog

## v1.0.5 - 2026-09-28

- Added a configurable **RDS group interruption events / minute** threshold in the FM Monitor panel and `PushoverWatchdog.json`.
- The base interruption remains unchanged: one event is created only after **4 consecutive raw RDS frames with unreadable block B (`----`)**.
- Alerts can now require multiple distinct interruption events inside a rolling **60-second** window. A usable RDS group must appear before another four-frame interruption can count as a new event, so one continuous unreadable streak is never multiplied into several events.
- Default threshold is **1 event/minute** to preserve v1.0.4 behaviour after upgrade. The server normalizes the value to a safe integer range of 1-600.
- The rolling interruption history is bounded and is reset when RDS group tracking is reset, suspended off-target, or carrier-gated, preventing stale events from causing false positives after monitoring resumes.
- Moved the short-interruption state/window logic into a small dedicated module to keep the backend path testable and avoid duplicate threshold logic.
- Completed a full security, lifecycle, performance and maintainability audit.
- Removed dead runtime state (`pluginWs`, unused stereo recovery state and unused off-target marker), an unused audio-analysis parameter and unused notification-function parameters.
- Deduplicated repeated RDS-group observation reset code into one internal helper while preserving alert/recovery semantics.
- Deduplicated the common bounded HTTPS form-post transport used by Pushover and Telegram; channel-specific payloads, limits, timeouts and error text remain unchanged.
- Prevented unnecessary full RadioText log rewrites when periodic pruning removes nothing, reducing avoidable disk I/O and CPU spikes on long histories while retaining the same seven-day/cap enforcement.
- Cleared stale cached `/text` receiver data when that local WebSocket disconnects so the existing `dataHandler.dataToSend` fallback is actually used until reconnection.
- Strengthened administrator WebSocket handling by checking the live session object plus Origin state for each privileged/sensitive action instead of relying only on a one-time boolean snapshot.
- Fixed frontend admin-session teardown so the privileged plugin WebSocket is closed and admin-only settings/RadioText DOM is removed when administrator state disappears; reconnect is suppressed until administrator state is present again.
- Modernized the plugin manifest/runtime global usage (`const`, `globalThis`) and kept all public configuration keys, defaults, thresholds and version identifiers unchanged.
- Fixed UI configuration saves so server-only and forward-compatible keys are retained instead of being silently reset; in particular, saving from the panel no longer forces `debugLogging` to `false`.
- Enforced Pushover Emergency API bounds in both config normalization and outbound payload construction: retry remains at least 30 seconds and retry/expire are capped at 10800 seconds, with expire never lower than retry.
- Modernized Telegram `sendMessage` preview suppression from the removed legacy `disable_web_page_preview` parameter to the current JSON-serialized `link_preview_options` form while preserving the same no-preview behaviour.
- Strengthened privileged `/data_plugins` actions by reloading the FM-DX `express-session` state from the session store before each settings, RadioText, save or test operation, so a logged-out WebSocket cannot continue using a stale administrator snapshot for commands.
- Added a low-frequency lifetime admin-session guard in the frontend so settings/log UI and its plugin WebSocket are torn down after admin state disappears even after the initial boot-observer window.
- Hardened shared plugin-WebSocket input handling in the browser with message-size and object-shape validation, plus bounded RadioText page acceptance, reducing malformed/forged client-broadcast messages from causing avoidable parsing, DOM or memory work.
- Stopped rebuilding the complete RadioText modal on each page/refresh and now batch-inserts log rows with a `DocumentFragment`, reducing avoidable DOM churn while keeping the same displayed history and controls.
- Made backend hot-reload lifecycle helpers idempotent and stop-aware so callbacks cannot re-arm timers after teardown.
- Included the injected frontend stylesheet in hot-reload/logout cleanup so a reloaded plugin cannot retain stale CSS from an older copy.
- Removed additional dead runtime state (`observedFrequencyChangedAt`, unused audio source-name bookkeeping and an unused local RDS variable).
- Fixed explicit valid `0` settings being replaced by legacy fallback values at runtime for tune settle, alert cooldown, signal threshold and audio-silence threshold.
- Fixed exact digital silence (`-Infinity dBFS`, produced by all-zero PCM) so it is handled as silence by the existing blank-audio detector.
- Reduced work in the PCM hot path by normalizing once per buffer instead of once per sample, and removed unused RMS and observed-frequency runtime state.
- Reworked RadioText and stereo-history pruning in place to avoid repeated full-array allocations while preserving the same retention/window semantics.
- Changed RadioText maintenance rewrites to bounded chunked atomic writes, avoiding a transient full-log string/array allocation while retaining the same JSONL format and private-file handling.
- Hardened the local `/text` and `/rds` WebSocket clients with parser-level payload caps, disabled unnecessary loopback compression and consolidated safe socket teardown.
- Added per-admin-connection server-origin tokens for sensitive Pushover Watchdog replies so client-originated messages rebroadcast by FM-DX `/data_plugins` cannot impersonate backend config/status/toast/log responses in the plugin UI.
- Hardened notification HTTP response handling so oversized remote responses are aborted immediately instead of continuing to drain data after the configured cap.
- Reused already-normalized frequency configuration in the scheduler, bounded malformed frequency identifiers, and made frontend runtime shutdown idempotent.
- Fixed the rare plugin-channel token generation failure path so its error logging uses a defined, bounded error sanitizer instead of throwing a secondary `ReferenceError`.
- Coalesced bursty startup `MutationObserver` callbacks into a single short-delay admin/UI refresh, avoiding redundant full-page authentication scans on DOM-heavy FM-DX views while retaining the existing one-second polling fallback and 30-second observer window.
- Revalidated administrator sessions for backend broadcasts as well as privileged actions, coalescing concurrent refreshes and retaining only the latest pending value per broadcast type while the session store is slow.
- Prevented stale session-reload continuations from restoring authentication state or performing actions after a client disconnect or plugin teardown; channel-token creation failure now fails closed for privileged actions.
- Stopped delayed tune completions from applying receiver options after plugin teardown and tracked notification HTTPS requests/Zabbix sockets so retired runtimes cancel their own pending transports.
- Caught RadioText maintenance write failures at the shared pruning boundary and retained a pending rewrite for retry, preventing disk errors from escaping timer/page callbacks.
- Consolidated frontend stop/logout teardown, released retained RadioText pagination data, ignored events from obsolete sockets, and guarded sends against teardown and socket-close races.
- Removed an unused off-target helper parameter and replaced the legacy Zabbix Buffer encoding alias `binary` with its byte-equivalent `latin1` name.
- Replaced browser-config denylisting with one explicit UI allowlist for both reads and saves: credentials, `debugLogging`, forward-compatible and future server-only keys can no longer leak into or be overwritten from `/data_plugins`, while their on-disk values are preserved.
- Added a fail-closed 5-second administrator session-refresh deadline, including teardown cancellation and late-callback suppression, so a stalled session store cannot retain pending privileged actions or broadcast queues indefinitely.
- Added a 12-second absolute transport deadline around Pushover/Telegram HTTPS and Zabbix TCP delivery in addition to the existing socket inactivity timeout, preventing DNS/connect stalls from retaining runtime cleanup state.
- Kept the 100,000-entry RadioText memory cap and existing retention semantics, but deferred cap-triggered full JSONL rewrites to periodic maintenance so high-churn RT cannot cause a synchronous whole-log rewrite on every new settled entry.
- Re-ran syntax checks, config-schema parity checks, RDS interruption tests, authenticated WebSocket/security tests, lifecycle hot-reload/teardown tests, stalled-session and stalled-notification tests, plus a reduced-cap RadioText maintenance stress test.

## v1.0.4 - 2026-09-14

- Added detection for short **RDS group decoding interruptions** that do not last long enough to trigger the existing group-stream-loss timer.
- A decoding interruption is reported after **4 consecutive raw RDS frames with an unreadable block B** (`----`), matching the `--` gaps visible in RDS Expert.
- The short-interruption detector only runs after the normal three-group baseline has armed and only while the receiver is stably tuned to the configured watchdog frequency.
- Valid RDS group decoding immediately resets the unreadable-frame streak; recovery uses the existing recovery confirmation and notification flow.
- Preserved the existing long-duration RDS group-stream-loss detector, off-target suspension logic, notification channels and receiver retune behaviour.

## v1.0.3 - 2026-07-13

- Fixed false positive **RDS group stream lost** alerts when the operator temporarily tunes the receiver away from the configured watchdog frequency.
- RDS group monitoring is now explicitly suspended while the receiver is off the active monitored frequency and is re-armed only after the target frequency is observed as stable again.
- The raw `/rds` stream is still ignored unless the receiver is on the configured target frequency; groups from temporarily monitored stations are not counted for the watchdog target.
- Preserved the existing RDS group baseline logic, recovery handling, notification channels and receiver retune behaviour.

## v1.0.2 - 2026-07-05

- Added optional **RDS group stream monitoring** based on FM-DX Webserver’s local raw `/rds` WebSocket. The plugin now detects when a previously active stream of usable RDS groups suddenly stops.
- Added a configurable group-stream loss timer and an optional carrier requirement in the FM Monitor panel and `PushoverWatchdog.json`.
- The detector arms only after three usable RDS groups have been received on the current target frequency, preventing false alerts on stations that never provided group traffic.
- A usable group requires a valid RDS block B, which contains the group type/version. This matches the practical operator view in RDS Expert and ignores malformed or unreadable group frames.
- Added `rdsGroupsMissing` alerts and recovery handling, including the last usable group type in notifications and live status.
- Added bounded, loopback-only `/rds` WebSocket handling with input-size limits, strict frame validation, reconnect cleanup and no alerting when the local raw-RDS socket itself is unavailable.
- Updated `README.md` and `PushoverWatchdog.example.json` with the new monitoring option.

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
