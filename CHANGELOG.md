# Changelog

## v1.0.1 - 2026-06-02

- Added optional **RadioText logging** in the admin panel, with a dedicated top-panel log button and an admin-only RadioText history viewer.
- Added configurable **Telegram Bot** notifications with independent enable/disable control and test action.
- Added configurable **Zabbix sender / trapper** delivery with independent enable/disable control and test action.
- Added per-channel notification enable switches so Pushover, Telegram and Zabbix can be used independently or together.
- Added receiver settings applied after watchdog tune/retune: FM bandwidth selection including **AUTO**, and cEQ/iMS choices for keep current, enabled or disabled.
- Updated `PushoverWatchdog.example.json` with the new notification, RadioText and receiver-option settings.

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
