'use strict';

/*
  Pushover Watchdog for FM-DX Webserver v1.4.x - by Play Radio Constanta
  - Hot-reloads plugins_configs/PushoverWatchdog.json without server restart.
  - Checks configured FM frequencies in rotation.
  - Sends Pushover alerts for:
      1) signal below threshold / white noise: RF signal below the user-defined expected level, evaluated in the configured signal unit
      2) blank / silence: RF signal present, but captured audio below threshold for a configured period
      3) RDS missing: RF signal present, but no valid RDS identity (PI or PS) is decoded for a configured period
      4) stereo indicator unstable/off: the webserver stereo flag drops repeatedly while signal/audio are otherwise OK
  - Sends optional recovery notifications.
*/

const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');

const { logInfo, logWarn, logError } = require('../../server/console');
const { serverConfig } = require('../../server/server_config');
const dataHandler = require('../../server/datahandler');
const pluginsApi = require('../../server/plugins_api');
const audioServer = require('../../server/stream/3las.server');

const PLUGIN_NAME = 'Pushover Watchdog';
const CONFIG_PATH = path.join(__dirname, '../../plugins_configs/PushoverWatchdog.json');
const DBF_TO_DBUV_OFFSET = 11.25;
const DBF_TO_DBM_OFFSET = 120;
const MAX_PLUGIN_MESSAGE_BYTES = 65536;
const MAX_PUSHOVER_MESSAGE_CHARS = 950;
const MAX_FREQUENCIES = 64;
const MIN_TUNE_COMMAND_GAP_MS = 3000;
const MAX_PUSHOVER_RESPONSE_BYTES = 32768;
const MAX_CONFIG_STRING_CHARS = 512;
const MAX_TEXT_WS_MESSAGE_BYTES = 262144;
const MAX_STATUS_STRING_CHARS = 128;
const RUNTIME_KEY = '__PushoverWatchdogRuntime';

// FM-DX can reload plugins inside the same Node.js process. Keep a small
// runtime registry so an old copy does not leave active timers, WebSockets,
// or event listeners behind after a reload.
if (global[RUNTIME_KEY] && typeof global[RUNTIME_KEY].stop === 'function') {
  try { global[RUNTIME_KEY].stop(); } catch (_) {}
}

const runtime = {
  timers: new Set(),
  cleanups: new Set(),
  stop() {
    for (const timer of this.timers) {
      try { clearTimeout(timer); clearInterval(timer); } catch (_) {}
    }
    this.timers.clear();
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch (_) {}
    }
    this.cleanups.clear();
  }
};
global[RUNTIME_KEY] = runtime;

function runtimeSetTimeout(fn, delay) {
  const timer = setTimeout(() => {
    runtime.timers.delete(timer);
    fn();
  }, delay);
  runtime.timers.add(timer);
  return timer;
}

function runtimeSetInterval(fn, delay) {
  const timer = setInterval(fn, delay);
  runtime.timers.add(timer);
  return timer;
}

function runtimeClearTimer(timer) {
  if (!timer) return;
  clearTimeout(timer);
  clearInterval(timer);
  runtime.timers.delete(timer);
}

function runtimeAddCleanup(fn) {
  runtime.cleanups.add(fn);
  return fn;
}

const defaultConfig = {
  enabled: true,

  pushoverUserKey: '',
  pushoverApiToken: '',
  pushoverDevice: '',
  pushoverSound: 'pushover',
  pushoverPriority: 0,
  pushoverRetrySeconds: 60,
  pushoverExpireSeconds: 1800,

  frequencies: ['91.600'],
  checkIntervalSeconds: 2,
  tuneSettleSeconds: 4,
  dwellSeconds: 30,
  forceRetuneSeconds: 10,

  signalUnit: 'dbuv',
  signalThreshold: 20,
  noCarrierSeconds: 20,

  rdsMissingSeconds: 30,
  requireCarrierForRds: true,

  blankSeconds: 30,
  audioSilenceThresholdDbfs: -45,
  requireCarrierForBlank: true,

  stereoMonitorEnabled: true,
  stereoWindowSeconds: 60,
  stereoMinDrops: 3,
  stereoMinOffSamples: 2,
  stereoRequireCarrier: true,
  stereoRequireAudio: true,
  stereoRequireRdsValid: false,
  stereoRecoverySeconds: 30,

  recoverySeconds: 10,
  alertCooldownMinutes: 10,
  sendRecoveryNotifications: true,

  includeRdsInfo: true,
  debugLogging: false
};

function mergeAndNormalizeConfig(rawConfig) {
  const merged = { ...defaultConfig, ...(rawConfig || {}) };
  merged.frequencies = normalizeFrequencies(merged.frequencies);
  merged.pushoverUserKey = cleanConfigString(merged.pushoverUserKey, 128);
  merged.pushoverApiToken = cleanConfigString(merged.pushoverApiToken, 128);
  merged.pushoverDevice = cleanConfigString(merged.pushoverDevice, 128);
  merged.pushoverSound = cleanConfigString(merged.pushoverSound, 64) || defaultConfig.pushoverSound;
  merged.checkIntervalSeconds = positiveNumber(merged.checkIntervalSeconds, defaultConfig.checkIntervalSeconds, 1);
  merged.tuneSettleSeconds = positiveNumber(merged.tuneSettleSeconds, defaultConfig.tuneSettleSeconds, 0);
  merged.dwellSeconds = positiveNumber(merged.dwellSeconds, defaultConfig.dwellSeconds, 5);
  merged.forceRetuneSeconds = positiveNumber(merged.forceRetuneSeconds, defaultConfig.forceRetuneSeconds, 0);
  merged.signalUnit = normalizeSignalUnit(merged.signalUnit || defaultConfig.signalUnit);
  merged.signalThreshold = finiteNumber(merged.signalThreshold, defaultConfig.signalThreshold);
  merged.noCarrierSeconds = positiveNumber(merged.noCarrierSeconds, defaultConfig.noCarrierSeconds, 1);
  merged.rdsMissingSeconds = positiveNumber(merged.rdsMissingSeconds, defaultConfig.rdsMissingSeconds, 1);
  merged.blankSeconds = positiveNumber(merged.blankSeconds, defaultConfig.blankSeconds, 1);
  merged.audioSilenceThresholdDbfs = finiteNumber(merged.audioSilenceThresholdDbfs, defaultConfig.audioSilenceThresholdDbfs);
  merged.stereoWindowSeconds = positiveNumber(merged.stereoWindowSeconds, defaultConfig.stereoWindowSeconds, Math.max(2, Number(merged.checkIntervalSeconds || defaultConfig.checkIntervalSeconds)));
  merged.stereoMinDrops = positiveNumber(merged.stereoMinDrops, defaultConfig.stereoMinDrops, 1);
  merged.stereoMinOffSamples = positiveNumber(merged.stereoMinOffSamples, defaultConfig.stereoMinOffSamples, 1);
  merged.stereoRecoverySeconds = positiveNumber(merged.stereoRecoverySeconds, defaultConfig.stereoRecoverySeconds, 1);
  merged.recoverySeconds = positiveNumber(merged.recoverySeconds, defaultConfig.recoverySeconds, 1);
  merged.alertCooldownMinutes = positiveNumber(merged.alertCooldownMinutes, defaultConfig.alertCooldownMinutes, 0);
  merged.pushoverPriority = Math.max(-2, Math.min(2, Math.trunc(finiteNumber(merged.pushoverPriority, defaultConfig.pushoverPriority))));
  merged.pushoverRetrySeconds = positiveNumber(merged.pushoverRetrySeconds, defaultConfig.pushoverRetrySeconds, 30);
  merged.pushoverExpireSeconds = positiveNumber(merged.pushoverExpireSeconds, defaultConfig.pushoverExpireSeconds, 30);
  if (merged.pushoverExpireSeconds < merged.pushoverRetrySeconds) {
    merged.pushoverExpireSeconds = merged.pushoverRetrySeconds;
  }
  return merged;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveNumber(value, fallback, min) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function cleanConfigString(value, maxChars = MAX_CONFIG_STRING_CHARS) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, Math.max(0, maxChars));
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeStatusString(value, maxChars = MAX_STATUS_STRING_CHARS) {
  return cleanConfigString(value, maxChars);
}

function sanitizeReceiverData(raw) {
  if (!isPlainObject(raw)) return {};
  return {
    freq: finiteNumber(raw.freq, NaN),
    sig: finiteNumber(raw.sig, NaN),
    pi: safeStatusString(raw.pi, 16),
    ps: safeStatusString(raw.ps, 16),
    rds: typeof raw.rds === 'boolean' || typeof raw.rds === 'number' ? raw.rds : safeStatusString(raw.rds, 32),
    st: typeof raw.st === 'boolean' || typeof raw.st === 'number' ? raw.st : safeStatusString(raw.st, 32),
    rt0: safeStatusString(raw.rt0, 128),
    rt1: safeStatusString(raw.rt1, 128)
  };
}

function normalizeSignalUnit(unit) {
  const u = String(unit || '').trim().toLowerCase();
  if (u === 'dbuv' || u === 'dbµv' || u === 'dbμv') return 'dbuv';
  if (u === 'dbm') return 'dbm';
  return 'dbf';
}

function signalUnitLabel(unit = config?.signalUnit) {
  const u = normalizeSignalUnit(unit);
  if (u === 'dbuv') return 'dBµV';
  if (u === 'dbm') return 'dBm';
  return 'dBf';
}

function signalFromRawDbf(rawDbf, unit = config?.signalUnit) {
  const v = Number(rawDbf);
  if (!Number.isFinite(v)) return NaN;
  const u = normalizeSignalUnit(unit);
  if (u === 'dbuv') return v - DBF_TO_DBUV_OFFSET;
  if (u === 'dbm') return v - DBF_TO_DBM_OFFSET;
  return v;
}

function formatSignal(rawDbf) {
  const raw = Number(rawDbf);
  if (!Number.isFinite(raw)) return 'n/a';
  const unit = normalizeSignalUnit(config.signalUnit);
  const display = signalFromRawDbf(raw, unit);
  const main = `${display.toFixed(1)} ${signalUnitLabel(unit)}`;
  if (unit === 'dbf') return main;
  return `${main} (raw ${raw.toFixed(1)} dBf)`;
}

function readConfigFile() {
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
    existing = isPlainObject(parsed) ? parsed : {};
  }
  return mergeAndNormalizeConfig(existing);
}

function ensureConfig() {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let merged;
  try {
    merged = readConfigFile();
  } catch (err) {
    logError(`[${PLUGIN_NAME}] Invalid config JSON. Keeping defaults and rewriting a valid config: ${err.message}`);
    merged = mergeAndNormalizeConfig({});
  }

  writeConfigFile(merged);
  rememberConfigMtime();
  return merged;
}

function writeConfigFile(nextConfig) {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(nextConfig, null, 2), 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
  rememberConfigMtime();
}

function rememberConfigMtime() {
  try {
    configMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch (_) {}
}

function configAffectsFrequencyLoop(oldConfig, newConfig) {
  return JSON.stringify(oldConfig?.frequencies || []) !== JSON.stringify(newConfig?.frequencies || []) ||
    Number(oldConfig?.dwellSeconds) !== Number(newConfig?.dwellSeconds) ||
    Number(oldConfig?.tuneSettleSeconds) !== Number(newConfig?.tuneSettleSeconds) ||
    Number(oldConfig?.checkIntervalSeconds) !== Number(newConfig?.checkIntervalSeconds) ||
    Number(oldConfig?.forceRetuneSeconds) !== Number(newConfig?.forceRetuneSeconds);
}

function applyConfig(nextConfig, reason) {
  const previous = config;
  config = mergeAndNormalizeConfig(nextConfig);
  if (previous && configAffectsFrequencyLoop(previous, config)) {
    resetFrequencyStates();
  }
  sendPluginMessage('PushoverWatchdog:config', sanitizedConfigForUi(config));
  sendPluginMessage('PushoverWatchdog:status', currentStatusPayload());
  logInfo(`[${PLUGIN_NAME}] Configuration reloaded (${reason}).`);
}

function reloadConfigFromDisk(reason) {
  try {
    const reloaded = readConfigFile();
    rememberConfigMtime();
    applyConfig(reloaded, reason);
  } catch (err) {
    const now = Date.now();
    if (!lastConfigErrorAt || now - lastConfigErrorAt > 5000) {
      lastConfigErrorAt = now;
      logWarn(`[${PLUGIN_NAME}] Config reload skipped because JSON is not valid yet: ${err.message}`);
    }
  }
}

function startConfigHotReload() {
  try {
    const watcher = fs.watch(CONFIG_PATH, { persistent: false }, () => scheduleConfigReload('file change'));
    runtimeAddCleanup(() => {
      try { watcher.close(); } catch (_) {}
    });
  } catch (err) {
    logWarn(`[${PLUGIN_NAME}] fs.watch could not be started, using polling only: ${err.message}`);
  }

  runtimeSetInterval(() => {
    try {
      const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
      if (configMtimeMs && mtime !== configMtimeMs) scheduleConfigReload('mtime change');
    } catch (err) {
      const now = Date.now();
      if (!lastConfigErrorAt || now - lastConfigErrorAt > 30000) {
        lastConfigErrorAt = now;
        logWarn(`[${PLUGIN_NAME}] Config file stat failed: ${err.message}`);
      }
    }
  }, 1000);
}

function scheduleConfigReload(reason) {
  runtimeClearTimer(configReloadTimer);
  configReloadTimer = runtimeSetTimeout(() => {
    configReloadTimer = null;
    try {
      const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
      if (mtime === configMtimeMs) return;
    } catch (_) {}
    reloadConfigFromDisk(reason);
  }, 250);
}

function saveConfig(newConfig) {
  const merged = mergeAndNormalizeConfig(newConfig);
  writeConfigFile(merged);
  applyConfig(merged, 'UI save');
  return merged;
}

function normalizeFrequencies(value) {
  let list = value;
  if (typeof value === 'string') {
    list = value.split(/[\s,;]+/);
  }
  if (!Array.isArray(list)) list = [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const n = Number(String(item).replace(',', '.').trim());
    if (!Number.isFinite(n) || n <= 0) continue;
    const f = n.toFixed(3);
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
      if (out.length >= MAX_FREQUENCIES) break;
    }
  }
  return out;
}

let configMtimeMs = 0;
let configReloadTimer = null;
let lastConfigErrorAt = 0;
let lastForcedTuneAt = 0;
let offTargetSinceAt = 0;
let lastTuneCommandAt = 0;
let lastTuneCommandFreq = null;
let config = ensureConfig();
let freqIndex = 0;
let activeFrequency = null;
let activeTuneStartedAt = 0;
let lastCheckAt = 0;
let lastData = null;
let textWs = null;
let pluginWs = null;
let states = new Map();
let currentAudio = {
  dbfs: -Infinity,
  rms: 0,
  lastUpdate: 0,
  attached: false,
  sourceName: ''
};
let lastAudioStream = null;
let audioDataHandler = null;
let audioCloseHandler = null;
let textReconnectTimer = null;
let connectingTextWebSocket = false;

function logDebug(message) {
  if (config.debugLogging) logInfo(`[${PLUGIN_NAME}] ${message}`);
}

function frequencyKey(freq) {
  const n = Number(freq);
  return Number.isFinite(n) ? n.toFixed(3) : String(freq || 'unknown');
}

function getState(freq) {
  const key = frequencyKey(freq);
  if (!states.has(key)) {
    states.set(key, {
      noCarrierSince: 0,
      rdsMissingSince: 0,
      blankSince: 0,
      stereoHistory: [],
      stereoRecoverySince: 0,
      recoverySince: 0,
      noCarrierAlerted: false,
      rdsMissingAlerted: false,
      blankAlerted: false,
      stereoAlerted: false,
      lastNoCarrierAlert: 0,
      lastRdsMissingAlert: 0,
      lastBlankAlert: 0,
      lastStereoAlert: 0,
      lastRecoveryAlert: 0
    });
  }
  return states.get(key);
}

function resetFrequencyStates() {
  states = new Map();
  freqIndex = 0;
  activeFrequency = null;
  activeTuneStartedAt = 0;
  offTargetSinceAt = 0;
}


function isSensitivePluginMessage(type) {
  return type === 'PushoverWatchdog:config' || type === 'PushoverWatchdog:toast';
}

function sendPluginMessage(type, value) {
  const payload = JSON.stringify({ type, value });
  const sensitive = isSensitivePluginMessage(type);
  const wss = pluginsApi.getPluginsWss();
  if (wss) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && (!sensitive || client.__pushoverWatchdogAuthenticated === true)) {
        try { client.send(payload); } catch (_) {}
      }
    });
  }
}

function sendPluginMessageTo(client, type, value) {
  if (!client || client.readyState !== WebSocket.OPEN) return;
  try { client.send(JSON.stringify({ type, value })); } catch (_) {}
}

function isAuthenticatedWs(client) {
  return client && client.__pushoverWatchdogAuthenticated === true;
}

function rejectUnauthenticated(client, action) {
  sendPluginMessageTo(client, 'PushoverWatchdog:toast', {
    level: 'error',
    message: `Login required to ${action}.`
  });
  logWarn(`[${PLUGIN_NAME}] Rejected unauthenticated plugin action: ${action}.`);
}

function detachAudioMonitor() {
  if (lastAudioStream) {
    try {
      if (audioDataHandler) lastAudioStream.off('data', audioDataHandler);
      if (audioCloseHandler) {
        lastAudioStream.off('close', audioCloseHandler);
        lastAudioStream.off('end', audioCloseHandler);
        lastAudioStream.off('error', audioCloseHandler);
      }
    } catch (_) {}
  }
  lastAudioStream = null;
  audioDataHandler = null;
  audioCloseHandler = null;
  currentAudio.attached = false;
  currentAudio.sourceName = '';
  currentAudio.lastUpdate = 0;
  currentAudio.dbfs = -Infinity;
  currentAudio.rms = 0;
}

runtimeAddCleanup(detachAudioMonitor);

function attachAudioMonitor() {
  const srv = audioServer.Server;
  const stream = srv && srv.StdIn;
  if (!stream || stream === process.stdin) return;
  if (stream === lastAudioStream) return;

  // If FM-DX swaps the audio stream without closing the old one, remove the old
  // listeners before attaching to the new stream. This prevents duplicate audio
  // analysis work and listener accumulation.
  detachAudioMonitor();

  lastAudioStream = stream;
  currentAudio.attached = true;
  currentAudio.sourceName = stream.constructor ? stream.constructor.name : 'audio stream';

  audioDataHandler = (buffer) => {
    try {
      processAudioBuffer(buffer, Number(serverConfig.audio.audioChannels || 2));
    } catch (err) {
      logWarn(`[${PLUGIN_NAME}] Audio analysis error: ${err.message}`);
    }
  };

  audioCloseHandler = () => {
    if (lastAudioStream === stream) detachAudioMonitor();
  };

  stream.on('data', audioDataHandler);
  stream.on('close', audioCloseHandler);
  stream.on('end', audioCloseHandler);
  stream.on('error', audioCloseHandler);

  logInfo(`[${PLUGIN_NAME}] Audio monitor attached to FM-DX audio stream.`);
}

function processAudioBuffer(buffer, channels) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return;

  let sumSquares = 0;
  let samples = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i) / 32768;
    sumSquares += sample * sample;
    samples++;
  }
  if (!samples) return;

  const rms = Math.sqrt(sumSquares / samples);
  const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

  // Light smoothing, enough for silence detection without overreacting to one quiet buffer.
  if (!Number.isFinite(currentAudio.dbfs)) {
    currentAudio.dbfs = dbfs;
    currentAudio.rms = rms;
  } else {
    currentAudio.dbfs = (currentAudio.dbfs * 0.75) + (dbfs * 0.25);
    currentAudio.rms = (currentAudio.rms * 0.75) + (rms * 0.25);
  }
  currentAudio.lastUpdate = Date.now();
}

function closeTextWebSocket() {
  runtimeClearTimer(textReconnectTimer);
  textReconnectTimer = null;
  connectingTextWebSocket = false;
  if (textWs) {
    try { textWs.removeAllListeners(); } catch (_) {}
    try { textWs.close(); } catch (_) {}
    textWs = null;
  }
}

runtimeAddCleanup(closeTextWebSocket);

function scheduleTextWebSocketReconnect() {
  if (textReconnectTimer) return;
  textReconnectTimer = runtimeSetTimeout(() => {
    textReconnectTimer = null;
    connectTextWebSocket();
  }, 5000);
}

function connectTextWebSocket() {
  if (connectingTextWebSocket || (textWs && (textWs.readyState === WebSocket.OPEN || textWs.readyState === WebSocket.CONNECTING))) return;

  const webserverPort = serverConfig.webserver.webserverPort || 8080;
  const url = `ws://127.0.0.1:${webserverPort}/text`;

  connectingTextWebSocket = true;
  textWs = new WebSocket(url);
  textWs.on('open', () => {
    connectingTextWebSocket = false;
    logInfo(`[${PLUGIN_NAME}] Connected to /text WebSocket.`);
  });
  textWs.on('message', (message) => {
    try {
      if (Buffer.byteLength(message) > MAX_TEXT_WS_MESSAGE_BYTES) {
        logWarn(`[${PLUGIN_NAME}] Ignored oversized /text WebSocket message.`);
        return;
      }
      lastData = sanitizeReceiverData(JSON.parse(message.toString()));
    } catch (_) {}
  });
  textWs.on('error', err => {
    connectingTextWebSocket = false;
    logWarn(`[${PLUGIN_NAME}] /text WebSocket error: ${err.message}`);
  });
  textWs.on('close', () => {
    connectingTextWebSocket = false;
    textWs = null;
    logWarn(`[${PLUGIN_NAME}] /text WebSocket closed. Reconnecting in 5 seconds.`);
    scheduleTextWebSocketReconnect();
  });
}


function isAllowedWebSocketOrigin(request) {
  const origin = request?.headers?.origin;
  // Non-browser internal clients normally do not send Origin. They are still subject to session checks.
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const host = String(request?.headers?.host || '').toLowerCase();
    return originUrl.host.toLowerCase() === host;
  } catch (_) {
    return false;
  }
}

function registerPluginWebSocketAuthHandlers() {
  const wss = pluginsApi.getPluginsWss();
  if (!wss) {
    runtimeSetTimeout(registerPluginWebSocketAuthHandlers, 1000);
    return;
  }

  const connectionHandler = (client, request) => {
    const originAllowed = isAllowedWebSocketOrigin(request);
    client.__pushoverWatchdogAuthenticated = !!(originAllowed && (request.session?.isAdminAuthenticated || request.session?.isTuneAuthenticated));
    if (!originAllowed) logWarn(`[${PLUGIN_NAME}] Rejected plugin WebSocket actions due to invalid Origin header.`);

    client.on('message', (message) => {
      if (Buffer.byteLength(message) > MAX_PLUGIN_MESSAGE_BYTES) {
        logWarn(`[${PLUGIN_NAME}] Ignored oversized plugin WebSocket message.`);
        return;
      }
      let event;
      try { event = JSON.parse(message.toString()); } catch (_) { return; }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
      if (!event.type.startsWith('PushoverWatchdog:')) return;

      if (event.type === 'PushoverWatchdog:getConfig') {
        if (!isAuthenticatedWs(client)) return rejectUnauthenticated(client, 'view Pushover Watchdog settings');
        sendPluginMessageTo(client, 'PushoverWatchdog:config', sanitizedConfigForUi());
        return;
      }

      if (event.type === 'PushoverWatchdog:saveConfig') {
        if (!isAuthenticatedWs(client)) return rejectUnauthenticated(client, 'save Pushover Watchdog settings');
        try {
          const saved = saveConfig(isPlainObject(event.value) ? event.value : {});
          sendPluginMessageTo(client, 'PushoverWatchdog:config', sanitizedConfigForUi(saved));
          sendPluginMessageTo(client, 'PushoverWatchdog:toast', { level: 'success', message: 'Pushover Watchdog settings saved.' });
          logInfo(`[${PLUGIN_NAME}] Configuration saved from authenticated UI.`);
        } catch (err) {
          sendPluginMessageTo(client, 'PushoverWatchdog:toast', { level: 'error', message: `Save failed: ${err.message}` });
        }
        return;
      }

      if (event.type === 'PushoverWatchdog:test') {
        if (!isAuthenticatedWs(client)) return rejectUnauthenticated(client, 'send Pushover Watchdog test notifications');
        sendPushover('FM-DX Watchdog test', 'Test notification from Pushover Watchdog.', 'test')
          .then(() => sendPluginMessageTo(client, 'PushoverWatchdog:toast', { level: 'success', message: 'Test notification sent.' }))
          .catch(err => sendPluginMessageTo(client, 'PushoverWatchdog:toast', { level: 'error', message: `Pushover test failed: ${err.message}` }));
      }
    });
  };

  wss.on('connection', connectionHandler);
  runtimeAddCleanup(() => {
    try { wss.off('connection', connectionHandler); } catch (_) {}
  });

  logInfo(`[${PLUGIN_NAME}] Authenticated-only WebSocket protection enabled.`);
}

function sanitizedConfigForUi(cfg = config) {
  return {
    ...cfg,
    pushoverUserKey: cfg.pushoverUserKey || '',
    pushoverApiToken: cfg.pushoverApiToken || ''
  };
}

function currentObservedFrequency() {
  const d = lastData || sanitizeReceiverData(dataHandler.dataToSend) || {}
  const f = Number(d.freq);
  return Number.isFinite(f) ? f : NaN;
}

function isObservedOnFrequency(freq, toleranceMhz = 0.015) {
  const observed = currentObservedFrequency();
  const target = Number(freq);
  return Number.isFinite(observed) && Number.isFinite(target) && Math.abs(observed - target) <= toleranceMhz;
}

function tuneTo(freq, reason = 'scheduled', options = {}) {
  const mhz = Number(freq);
  if (!Number.isFinite(mhz)) return;

  const force = options && options.force === true;
  const key = frequencyKey(freq);
  const now = Date.now();

  if (!force && isObservedOnFrequency(freq)) {
    logDebug(`Skipped tune to ${key} MHz (${reason}) because receiver is already on target.`);
    return;
  }

  if (!force && lastTuneCommandFreq === key && (now - lastTuneCommandAt) < MIN_TUNE_COMMAND_GAP_MS) {
    logDebug(`Skipped duplicate tune to ${key} MHz (${reason}).`);
    return;
  }

  lastTuneCommandAt = now;
  lastTuneCommandFreq = key;
  const command = `T${Math.round(mhz * 1000)}`;
  Promise.resolve(pluginsApi.sendPrivilegedCommand(command, true))
    .then(ok => {
      if (ok) logDebug(`Tuned to ${key} MHz (${reason})`);
      else logWarn(`[${PLUGIN_NAME}] Could not tune to ${key} MHz (${reason}).`);
    })
    .catch(err => logWarn(`[${PLUGIN_NAME}] Tune command failed for ${key} MHz (${reason}): ${err.message}`));
}

function chooseNextFrequency(now) {
  const freqs = normalizeFrequencies(config.frequencies);
  if (!freqs.length) return null;

  if (!activeFrequency) {
    activeFrequency = freqs[0];
    activeTuneStartedAt = now;
    offTargetSinceAt = 0;
    tuneTo(activeFrequency, 'initial target');
    return activeFrequency;
  }

  // If only one frequency is configured, do not periodically retune it on dwellSeconds.
  // In single-frequency monitoring, forceRetuneSeconds is the only setting that should
  // bring a manually changed receiver back to the monitored frequency.
  if (freqs.length === 1) {
    const only = freqs[0];
    if (frequencyKey(activeFrequency) !== frequencyKey(only)) {
      activeFrequency = only;
      activeTuneStartedAt = now;
      offTargetSinceAt = 0;
      tuneTo(activeFrequency, 'single target changed');
    }
    return activeFrequency;
  }

  if ((now - activeTuneStartedAt) >= Math.max(5, Number(config.dwellSeconds || 30)) * 1000) {
    freqIndex = (freqIndex + 1) % freqs.length;
    activeFrequency = freqs[freqIndex];
    activeTuneStartedAt = now;
    offTargetSinceAt = 0;
    tuneTo(activeFrequency, 'next target');
  }
  return activeFrequency;
}

function currentStatusPayload() {
  const d = lastData || sanitizeReceiverData(dataHandler.dataToSend) || {}
  return {
    activeFrequency,
    currentFrequency: d.freq,
    signal: signalFromRawDbf(d.sig),
    signalRawDbf: Number(d.sig),
    signalUnit: normalizeSignalUnit(config.signalUnit),
    signalUnitLabel: signalUnitLabel(config.signalUnit),
    pi: d.pi,
    ps: d.ps,
    rds: d.rds,
    rdsPresent: isRdsPresent(d),
    rdsValid: hasValidRdsIdentity(d),
    stereo: isStereoOn(d),
    stereoRaw: d.st,
    rt0: d.rt0,
    rt1: d.rt1,
    audioDbfs: Number.isFinite(currentAudio.dbfs) ? Number(currentAudio.dbfs.toFixed(1)) : null,
    audioAttached: currentAudio.attached,
    audioAgeSeconds: currentAudio.lastUpdate ? Number(((Date.now() - currentAudio.lastUpdate) / 1000).toFixed(1)) : null,
    enabled: !!config.enabled
  };
}

function tick() {
  const now = Date.now();
  attachAudioMonitor();

  if (!config.enabled) {
    sendPluginMessage('PushoverWatchdog:status', currentStatusPayload());
    return;
  }

  if ((now - lastCheckAt) < Math.max(1, Number(config.checkIntervalSeconds || 2)) * 1000) return;
  lastCheckAt = now;

  const targetFreq = chooseNextFrequency(now);
  if (!targetFreq) {
    sendPluginMessage('PushoverWatchdog:status', currentStatusPayload());
    return;
  }

  const settleMs = Math.max(0, Number(config.tuneSettleSeconds || 4)) * 1000;
  if ((now - activeTuneStartedAt) < settleMs) {
    sendPluginMessage('PushoverWatchdog:status', currentStatusPayload());
    return;
  }

  const d = lastData || sanitizeReceiverData(dataHandler.dataToSend) || {}
  const observedFreq = Number(d.freq);
  const target = Number(targetFreq);
  if (!Number.isFinite(observedFreq) || Math.abs(observedFreq - target) > 0.015) {
    maybeForceRetune(targetFreq, observedFreq, now);
    sendPluginMessage('PushoverWatchdog:status', currentStatusPayload());
    return;
  }
  offTargetSinceAt = 0;

  evaluateFrequency(targetFreq, d, now);
  sendPluginMessage('PushoverWatchdog:status', currentStatusPayload());
}


function maybeForceRetune(targetFreq, observedFreq, now) {
  const intervalSeconds = Number(config.forceRetuneSeconds || 0);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return;
  const intervalMs = intervalSeconds * 1000;

  // forceRetuneSeconds is a grace period since the receiver was first observed away
  // from the monitored target, not merely a cooldown between retune commands.
  if (!offTargetSinceAt) {
    offTargetSinceAt = now;
    logDebug(`Receiver is off target ${frequencyKey(targetFreq)} MHz, observed ${Number.isFinite(observedFreq) ? observedFreq.toFixed(3) : 'unknown'} MHz. Starting force-retune grace timer.`);
    return;
  }

  if ((now - offTargetSinceAt) < intervalMs) return;
  if (lastForcedTuneAt && (now - lastForcedTuneAt) < Math.max(1000, Math.min(intervalMs, 10000))) return;

  lastForcedTuneAt = now;
  activeTuneStartedAt = now;
  offTargetSinceAt = 0;
  tuneTo(targetFreq, `forced retune after ${intervalSeconds}s grace, observed ${Number.isFinite(observedFreq) ? observedFreq.toFixed(3) : 'unknown'} MHz`, { force: true });
}


function isNonEmptyText(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 0 && v !== '-' && v !== '?' && v.toLowerCase() !== 'n/a' && v.toLowerCase() !== 'null' && v.toLowerCase() !== 'undefined';
}

function isRdsLockPresent(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.rds === true) return true;
  if (typeof data.rds === 'string') {
    const v = data.rds.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === '1' || v === 'locked' || v === 'present';
  }
  if (typeof data.rds === 'number') return data.rds > 0;
  return false;
}

function hasValidRdsIdentity(data) {
  if (!data || typeof data !== 'object') return false;
  return isNonEmptyText(data.pi) || isNonEmptyText(data.ps);
}

function isRdsPresent(data) {
  // Presence means the receiver reports a raw RDS lock/pilot.
  // This may be false/transient on weak signal, noise, or immediately after tuning.
  return isRdsLockPresent(data);
}

function isRdsMissingForAlert(data) {
  // Alerting is based on decoded RDS identity, not on the raw RDS lock flag.
  // A lock without valid PI/PS is treated as not safe enough for monitoring.
  return !hasValidRdsIdentity(data);
}

function isStereoOn(data) {
  if (!data || typeof data !== 'object') return false;
  const value = data.st;
  if (value === true) return true;
  if (value === false || value === null || typeof value === 'undefined') return false;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === '1' || v === 'stereo' || v === 'on';
  }
  return false;
}

function updateStereoHistory(st, now, stereoOn, canCheckStereo) {
  if (!canCheckStereo) {
    st.stereoHistory = [];
    st.stereoRecoverySince = 0;
    return { drops: 0, offSamples: 0, samples: 0 };
  }

  const windowMs = Math.max(1, Number(config.stereoWindowSeconds || 60)) * 1000;
  st.stereoHistory.push({ t: now, on: !!stereoOn });
  st.stereoHistory = st.stereoHistory.filter(sample => now - sample.t <= windowMs);

  let drops = 0;
  let offSamples = 0;
  for (let i = 0; i < st.stereoHistory.length; i++) {
    if (!st.stereoHistory[i].on) offSamples++;
    if (i > 0 && st.stereoHistory[i - 1].on && !st.stereoHistory[i].on) drops++;
  }

  return { drops, offSamples, samples: st.stereoHistory.length };
}

function evaluateFrequency(freq, data, now) {
  const st = getState(freq);
  const signalRawDbf = Number(data.sig);
  const signal = signalFromRawDbf(signalRawDbf);
  const signalOk = Number.isFinite(signal) && signal >= Number(config.signalThreshold || 20);
  const audioFresh = currentAudio.lastUpdate && (now - currentAudio.lastUpdate < 10000);
  const audioDbfs = currentAudio.dbfs;
  const audioSilent = audioFresh && Number.isFinite(audioDbfs) && audioDbfs <= Number(config.audioSilenceThresholdDbfs || -45);
  const canCheckBlank = audioFresh && (!config.requireCarrierForBlank || signalOk);
  const rdsPresent = isRdsPresent(data);
  const canCheckRds = !config.requireCarrierForRds || signalOk;
  const stereoOn = isStereoOn(data);
  const canCheckStereo = !!config.stereoMonitorEnabled &&
    (!config.stereoRequireCarrier || signalOk) &&
    (!config.stereoRequireAudio || (audioFresh && !audioSilent)) &&
    (!config.stereoRequireRdsValid || hasValidRdsIdentity(data));

  // Signal-below-threshold / white-noise condition.
  if (!signalOk) {
    if (!st.noCarrierSince) st.noCarrierSince = now;
    const elapsed = (now - st.noCarrierSince) / 1000;
    if (elapsed >= Number(config.noCarrierSeconds || 20) && shouldSendActiveAlert(st.noCarrierAlerted, st.lastNoCarrierAlert, now)) {
      const wasAlerted = st.noCarrierAlerted;
      st.noCarrierAlerted = true;
      st.lastNoCarrierAlert = now;
      sendAlert('noCarrier', freq, data, activeAlertReason(`Signal below threshold / white noise detected for ${Math.round(elapsed)} seconds.`, wasAlerted, elapsed));
    }
  } else {
    st.noCarrierSince = 0;
  }

  // RDS missing condition. For alerts, require a valid decoded identity (PI or PS).
  // Raw RDS lock/pilot is informational only, because it can be false/transient on noise.
  const rdsMissingForAlert = isRdsMissingForAlert(data);
  if (canCheckRds && rdsMissingForAlert) {
    if (!st.rdsMissingSince) st.rdsMissingSince = now;
    const elapsed = (now - st.rdsMissingSince) / 1000;
    if (elapsed >= Number(config.rdsMissingSeconds || 30) && shouldSendActiveAlert(st.rdsMissingAlerted, st.lastRdsMissingAlert, now)) {
      const wasAlerted = st.rdsMissingAlerted;
      st.rdsMissingAlerted = true;
      st.lastRdsMissingAlert = now;
      sendAlert('rdsMissing', freq, data, activeAlertReason(`RDS identity missing for ${Math.round(elapsed)} seconds.`, wasAlerted, elapsed));
    }
  } else {
    st.rdsMissingSince = 0;
  }

  // Blank / silence condition.
  if (canCheckBlank && audioSilent) {
    if (!st.blankSince) st.blankSince = now;
    const elapsed = (now - st.blankSince) / 1000;
    if (elapsed >= Number(config.blankSeconds || 30) && shouldSendActiveAlert(st.blankAlerted, st.lastBlankAlert, now)) {
      const wasAlerted = st.blankAlerted;
      st.blankAlerted = true;
      st.lastBlankAlert = now;
      sendAlert('blank', freq, data, activeAlertReason(`Blank / no modulation detected for ${Math.round(elapsed)} seconds.`, wasAlerted, elapsed));
    }
  } else {
    st.blankSince = 0;
  }

  // Stereo indicator instability/off condition.
  const stereoStats = updateStereoHistory(st, now, stereoOn, canCheckStereo);
  if (canCheckStereo) {
    const stereoDropsTooOften = stereoStats.drops >= Number(config.stereoMinDrops || 3);
    const stereoOffTooOften = stereoStats.offSamples >= Number(config.stereoMinOffSamples || 2);
    if ((stereoDropsTooOften || stereoOffTooOften) && shouldSendActiveAlert(st.stereoAlerted, st.lastStereoAlert, now)) {
      const wasAlerted = st.stereoAlerted;
      st.stereoAlerted = true;
      st.lastStereoAlert = now;
      st.stereoRecoverySince = 0;
      sendAlert('stereoUnstable', freq, data, activeAlertReason(`Stereo indicator unstable/off: ${stereoStats.drops} drop(s), ${stereoStats.offSamples} off sample(s) in the last ${Math.round(Number(config.stereoWindowSeconds || 60))} seconds.`, wasAlerted, Math.round(Number(config.stereoWindowSeconds || 60))));
    }
  }

  const stereoNormal = st.stereoAlerted ? (canCheckStereo && stereoOn) : (!canCheckStereo || stereoOn);
  const normal = signalOk && (!canCheckBlank || !audioSilent) && (!canCheckRds || !isRdsMissingForAlert(data)) && stereoNormal;
  if (normal && (st.noCarrierAlerted || st.rdsMissingAlerted || st.blankAlerted || st.stereoAlerted)) {
    if (!st.recoverySince) st.recoverySince = now;
    const recoveredFor = (now - st.recoverySince) / 1000;
    const recoveryRequired = st.stereoAlerted && !st.noCarrierAlerted && !st.rdsMissingAlerted && !st.blankAlerted ? Number(config.stereoRecoverySeconds || 30) : Number(config.recoverySeconds || 10);
    if (recoveredFor >= recoveryRequired) {
      const recoveredTypes = [];
      if (st.noCarrierAlerted) recoveredTypes.push('carrier');
      if (st.rdsMissingAlerted) recoveredTypes.push('RDS');
      if (st.blankAlerted) recoveredTypes.push('modulation');
      if (st.stereoAlerted) recoveredTypes.push('stereo indicator');
      st.noCarrierAlerted = false;
      st.rdsMissingAlerted = false;
      st.blankAlerted = false;
      st.stereoAlerted = false;
      st.noCarrierSince = 0;
      st.rdsMissingSince = 0;
      st.blankSince = 0;
      st.stereoRecoverySince = 0;
      st.recoverySince = 0;

      if (config.sendRecoveryNotifications && cooldownOk(st.lastRecoveryAlert, now)) {
        st.lastRecoveryAlert = now;
        sendAlert('recovery', freq, data, `Recovered: ${recoveredTypes.join(' + ')} back to normal.`);
      }
    }
  } else if (!normal) {
    st.recoverySince = 0;
  }
}

function cooldownOk(lastAlert, now) {
  const cooldown = Math.max(0, Number(config.alertCooldownMinutes || 10)) * 60000;
  return !lastAlert || (now - lastAlert) >= cooldown;
}


function shouldSendActiveAlert(isAlreadyAlerted, lastAlertAt, now) {
  return (!isAlreadyAlerted || cooldownOk(lastAlertAt, now));
}

function activeAlertReason(baseReason, alreadyAlerted, elapsed) {
  if (!alreadyAlerted) return baseReason;
  return `${baseReason} Still active after ${Math.round(elapsed)} seconds.`;
}

function formatRds(data) {
  if (!config.includeRdsInfo) return '';
  const lines = [];
  const rdsLock = isRdsLockPresent(data);
  const rdsValid = hasValidRdsIdentity(data);
  lines.push(`PI: ${isNonEmptyText(data?.pi) ? String(data.pi).trim() : '?'}`);
  if (isNonEmptyText(data?.ps)) lines.push(`PS: ${String(data.ps).trim()}`);
  if (isNonEmptyText(data?.rt0) || isNonEmptyText(data?.rt1)) lines.push(`RT: ${String(data.rt0 || data.rt1).trim()}`);
  lines.push(`RDS lock: ${rdsLock ? 'yes' : '?'}`);
  lines.push(`RDS valid: ${rdsValid ? 'yes' : 'no'}`);
  return lines.length ? '\n' + lines.join('\n') : '';
}

function sendAlert(kind, freq, data, reason) {
  const signalRawDbf = Number(data.sig);
  const audioText = Number.isFinite(currentAudio.dbfs) ? `${currentAudio.dbfs.toFixed(1)} dBFS` : 'n/a';
  const titleMap = {
    noCarrier: 'FM-DX: Signal below threshold / white noise',
    rdsMissing: 'FM-DX: RDS missing',
    blank: 'FM-DX: Blank / no modulation',
    stereoUnstable: 'FM-DX: Stereo indicator unstable',
    recovery: 'FM-DX: Recovery'
  };
  const message = [
    reason,
    `Frequency: ${frequencyKey(freq)} MHz`,
    `Signal: ${formatSignal(signalRawDbf)}`,
    `Signal threshold: ${Number(config.signalThreshold).toFixed(1)} ${signalUnitLabel(config.signalUnit)}`,
    `Audio: ${audioText}`,
    `Stereo indicator: ${isStereoOn(data) ? 'yes' : 'no'}`,
    formatRds(data)
  ].filter(Boolean).join('\n');

  sendPushover(titleMap[kind] || 'FM-DX Watchdog', message, kind)
    .then(() => logInfo(`[${PLUGIN_NAME}] Pushover alert sent: ${kind} ${frequencyKey(freq)} MHz.`))
    .catch(err => logError(`[${PLUGIN_NAME}] Pushover alert failed: ${err.message}`));
}

function truncateText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function sendPushover(title, message, kind) {
  return new Promise((resolve, reject) => {
    if (!config.pushoverUserKey || !config.pushoverApiToken) {
      reject(new Error('Pushover User Key or API Token is missing.'));
      return;
    }

    const payload = new URLSearchParams();
    payload.set('token', config.pushoverApiToken);
    payload.set('user', config.pushoverUserKey);
    payload.set('title', title);
    payload.set('message', truncateText(message, MAX_PUSHOVER_MESSAGE_CHARS));
    const priority = Math.max(-2, Math.min(2, Math.trunc(Number(config.pushoverPriority ?? 0))));
    payload.set('priority', String(priority));
    if (priority === 2) {
      payload.set('retry', String(Math.max(30, Math.trunc(Number(config.pushoverRetrySeconds || 60)))));
      payload.set('expire', String(Math.max(30, Math.trunc(Number(config.pushoverExpireSeconds || 1800)))));
    }
    if (config.pushoverDevice) payload.set('device', config.pushoverDevice);
    if (config.pushoverSound) payload.set('sound', config.pushoverSound);

    const body = payload.toString();
    const req = https.request({
      method: 'POST',
      hostname: 'api.pushover.net',
      path: '/1/messages.json',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    }, (res) => {
      let response = '';
      let responseBytes = 0;
      res.on('data', chunk => {
        responseBytes += chunk.length || Buffer.byteLength(String(chunk));
        if (responseBytes <= MAX_PUSHOVER_RESPONSE_BYTES) {
          response += chunk.toString();
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(response);
        else reject(new Error(`HTTP ${res.statusCode}: ${truncateText(response, 512)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Pushover request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

startConfigHotReload();
connectTextWebSocket();
registerPluginWebSocketAuthHandlers();
runtimeSetInterval(tick, 1000);

logInfo(`[${PLUGIN_NAME}] Loaded. Config: ${CONFIG_PATH}`);
