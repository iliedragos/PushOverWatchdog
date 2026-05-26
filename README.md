# PushoverWatchdog FM-DX

**PushoverWatchdog FM-DX** is a plugin for **FM-DX Webserver** that monitors a selected FM frequency and sends alerts through **Pushover** when reception, modulation, RDS or stereo indicator problems are detected.

Created **by Play Radio Constanta**.

The plugin is designed for FM monitoring setups using TEF / Headless TEF receivers and FM-DX Webserver.

---

## Features

- Signal below threshold / white noise detection
- Blank audio / no modulation detection
- Missing valid RDS detection
- Stereo indicator instability detection
- Recovery notifications
- Pushover alert integration
- Configurable monitored frequency or frequency list
- Configurable force-retune interval
- Hot-reload configuration support
- Login-protected configuration panel
- Emergency priority support for Pushover notifications

---

## Requirements

To use this plugin, you need:

- A compatible **FM-DX Webserver** installation
- A working **TEF / Headless TEF** receiver
- Internet access for Pushover notifications
- A **Pushover account**
- Your Pushover **User Key**
- A Pushover **Application/API Token**

Useful Pushover links:

- Pushover official website: https://pushover.net/
- Create Application/API Token: https://pushover.net/apps/build
- Pushover API documentation: https://pushover.net/api

---

## Installation

Copy the plugin files into your FM-DX Webserver installation:

```text
plugins/PushoverWatchdog.js
plugins/PushoverWatchdog/
```

Enable the plugin in FM-DX Webserver settings:

```text
PushoverWatchdog/pushover-watchdog.js
```

Restart FM-DX Webserver after installing or replacing the plugin files.

After restart, log in to the web interface and open:

```text
FM Monitor
```

Use this panel to configure your Pushover credentials and monitoring settings.

---

## Configuration File

The plugin creates and reads this configuration file:

```text
plugins_configs/PushoverWatchdog.json
```

---

## Pushover Setup

In your Pushover account, copy your **User Key** from the main dashboard.

Then create an application/API token here:

```text
https://pushover.net/apps/build
```

Basic Pushover configuration:

```json
{
  "pushoverUserKey": "YOUR_USER_KEY",
  "pushoverApiToken": "YOUR_API_TOKEN",
  "pushoverDevice": "",
  "pushoverPriority": 1
}
```

`pushoverDevice` can be left empty.

If empty, Pushover sends notifications to all active devices linked to your account.

---

## Pushover Priority

Supported priority values:

| Value | Meaning |
|---:|---|
| `-2` | Lowest priority / silent |
| `-1` | Low priority |
| `0` | Normal priority |
| `1` | High priority |
| `2` | Emergency priority |

Recommended value:

```json
"pushoverPriority": 1
```

For emergency priority, Pushover requires both `retry` and `expire`:

```json
{
  "pushoverPriority": 2,
  "pushoverRetrySeconds": 60,
  "pushoverExpireSeconds": 1800
}
```

With this example, Pushover repeats the emergency alert every 60 seconds for up to 1800 seconds, unless it is acknowledged.

---

## Recommended Starting Configuration

```json
{
  "frequencies": [91.6],
  "checkIntervalSeconds": 2,
  "tuneSettleSeconds": 4,
  "dwellSeconds": 30,
  "forceRetuneSeconds": 300,

  "signalUnit": "dbuv",
  "signalThreshold": 30,
  "noCarrierSeconds": 20,

  "blankSeconds": 30,
  "audioSilenceThresholdDbfs": -45,
  "requireCarrierForBlank": true,

  "rdsMissingSeconds": 30,
  "requireCarrierForRds": true,

  "stereoMonitorEnabled": true,
  "stereoWindowSeconds": 60,
  "stereoMinDrops": 3,
  "stereoMinOffSamples": 2,
  "stereoRequireCarrier": true,
  "stereoRequireAudio": true,
  "stereoRequireRdsValid": false,
  "stereoRecoverySeconds": 30,

  "recoverySeconds": 10,
  "alertCooldownMinutes": 10,
  "sendRecoveryNotifications": true,
  "includeRdsInfo": true,
  "debugLogging": false,

  "pushoverUserKey": "YOUR_USER_KEY",
  "pushoverApiToken": "YOUR_API_TOKEN",
  "pushoverDevice": "",
  "pushoverPriority": 1,
  "pushoverRetrySeconds": 60,
  "pushoverExpireSeconds": 1800
}
```

---

## How It Works

The plugin periodically checks the currently tuned frequency and evaluates:

- Signal level
- Audio level
- RDS status
- PI / PS values
- Stereo indicator status

The main check interval is controlled by:

```json
"checkIntervalSeconds": 2
```

This means the plugin checks the receiver every 2 seconds.

The plugin does not need to poll the server every few milliseconds. Stereo instability is detected by analyzing stereo indicator changes over a longer time window.

---

## Frequency Monitoring

The monitored frequency or frequencies are configured using:

```json
"frequencies": [91.6]
```

With one frequency configured, the plugin monitors that frequency.

With multiple frequencies configured, the plugin can rotate between them.

Example:

```json
"frequencies": [91.6, 95.5, 101.1]
```

The time spent on each frequency is controlled by:

```json
"dwellSeconds": 30
```

---

## Force Retune

If the receiver is manually tuned away from the monitored frequency, the plugin can automatically tune it back after a configured delay.

Example:

```json
"forceRetuneSeconds": 300
```

This means the plugin waits 300 seconds before forcing the receiver back to the monitored frequency.

To disable force-retune:

```json
"forceRetuneSeconds": 0
```

With one configured frequency, `forceRetuneSeconds` acts as a grace period after the tuner is observed on another frequency.

---

## Important Monitoring Note

With a single TEF / Headless TEF receiver, the plugin cannot monitor another frequency in the background while the receiver is tuned elsewhere.

The receiver must be tuned to the monitored frequency for signal, audio, RDS and stereo checks to be accurate.

If `forceRetuneSeconds` is enabled, the plugin can bring the tuner back to the configured monitoring frequency after the selected delay.

---

## Alert Types

### Signal Below Threshold / White Noise

Triggered when the reported signal level stays below the configured threshold for the selected duration.

Example:

```json
{
  "signalUnit": "dbuv",
  "signalThreshold": 30,
  "noCarrierSeconds": 20
}
```

This alert is useful because TEF receivers may still report a visible signal value even when the received audio is mostly white noise.

The threshold should be configured according to the normal signal level of the monitored station, not as an absolute “zero RF” value.

---

### Blank Audio / No Modulation

Triggered when the carrier is present but the audio level stays below the configured dBFS threshold.

Example:

```json
{
  "blankSeconds": 30,
  "audioSilenceThresholdDbfs": -45,
  "requireCarrierForBlank": true
}
```

Recommended starting value:

```json
"audioSilenceThresholdDbfs": -45
```

If false alerts occur during quiet audio passages, use a lower value such as:

```json
"audioSilenceThresholdDbfs": -50
```

---

### Missing Valid RDS

Triggered when the signal is present but no valid RDS identification is decoded.

The plugin treats `RDS lock` as diagnostic information only.

Valid RDS is considered present when at least one of these is valid:

- PI
- PS

Example:

```json
{
  "rdsMissingSeconds": 30,
  "requireCarrierForRds": true
}
```

This means the plugin sends an alert if no valid PI or PS is detected for 30 seconds while the signal is above the configured threshold.

---

### Stereo Indicator Instability

Triggered when the stereo indicator becomes unstable inside a configured time window.

Example:

```json
{
  "stereoMonitorEnabled": true,
  "stereoWindowSeconds": 60,
  "stereoMinDrops": 3,
  "stereoMinOffSamples": 2,
  "stereoRequireCarrier": true,
  "stereoRequireAudio": true,
  "stereoRequireRdsValid": false,
  "stereoRecoverySeconds": 30
}
```

This does not query the server every few milliseconds.

It uses the normal check interval and analyzes stereo stability over a longer window.

Example alert condition:

```text
Stereo indicator dropped 3 times in the last 60 seconds.
```

---

## Recovery Notifications

If enabled, the plugin sends a notification when a previously detected issue returns to normal.

```json
"sendRecoveryNotifications": true
```

Recovery is confirmed only after the condition remains normal for the configured recovery period:

```json
"recoverySeconds": 10
```

---

## Configuration Hot Reload

The plugin supports hot-reloading of its configuration file.

Changes made to the configuration file are applied automatically without restarting FM-DX Webserver.

A restart is only required after replacing or updating the plugin files.

---

## Security Notes

The configuration panel is available only for authenticated users.

Unauthenticated users cannot:

- Open the FM Monitor configuration panel
- Read the plugin configuration
- View Pushover keys or tokens
- Save configuration changes
- Send test notifications


---

## Example Notification

```text
FM Monitor: Signal below threshold / white noise

Frequency: 91.600 MHz
Signal: 24.7 dBµV
Signal threshold: 30.0 dBµV
Audio: -18.3 dBFS
PI: ?
RDS lock: yes
RDS valid: no
```

---

## Troubleshooting

### The FM Monitor button does not appear

Make sure you are logged in to FM-DX Webserver.

Then refresh the browser cache using a hard refresh, for example:

```text
Ctrl + F5
```

### No Pushover notifications are received

Check that:

- `pushoverUserKey` is correct
- `pushoverApiToken` is correct
- The server has internet access
- `pushoverDevice` is either empty or matches a real Pushover device name

### Emergency priority fails

If using priority `2`, make sure these values are present:

```json
{
  "pushoverPriority": 2,
  "pushoverRetrySeconds": 60,
  "pushoverExpireSeconds": 1800
}
```

### False signal alerts

Lower `signalThreshold` or calibrate it according to the normal signal level of the monitored station.

### False blank alerts

Lower the silence threshold, for example:

```json
"audioSilenceThresholdDbfs": -50
```

### Stereo instability alerts during manual testing

The plugin monitors the stereo indicator reported by FM-DX Webserver. If manual changes cause repeated stereo on/off transitions, an alert may be triggered.

---
