# Changelog

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
