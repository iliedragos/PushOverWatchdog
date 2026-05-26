# PushoverWatchdog FM-DX

**PushoverWatchdog FM-DX** is a plugin for **FM-DX Webserver** that monitors a selected FM frequency and sends alerts through **Pushover** when reception or modulation problems are detected.

The plugin is designed for FM monitoring setups using TEF / Headless TEF receivers and FM-DX Webserver.

---

## Features

- Signal below threshold / white noise detection
- Blank audio / no modulation detection
- Missing valid RDS detection
- Stereo indicator instability detection
- Recovery notifications
- Pushover alert integration
- Configurable monitored frequency/frequencies
- Configurable force-retune interval
- Hot-reload configuration support
- Admin/login-protected configuration panel

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

- Pushover official website:  
  https://pushover.net/

- Create Application/API Token:  
  https://pushover.net/apps/build

- Pushover API documentation:  
  https://pushover.net/api

---

## Installation

Copy the plugin files into your FM-DX Webserver installation:

```text
plugins/PushoverWatchdog.js
plugins/PushoverWatchdog/
