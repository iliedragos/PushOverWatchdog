// Plugin configuration, this is used in the administration when plugins are loaded
var pluginConfig = {
    name: 'Pushover Watchdog',
    version: '1.0.0',
    author: 'by Play Radio Constanta',
    frontEndPath: 'PushoverWatchdog/pushover-watchdog.js'
}

// Backend code is loaded from plugins/PushoverWatchdog/pushover-watchdog_server.js
// when this frontend plugin is enabled in FM-DX Webserver settings.

module.exports = {
    pluginConfig
}
