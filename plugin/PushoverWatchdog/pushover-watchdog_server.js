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
  - Provides rolling RadioText logging, retained for the most recent 7 days.
  - Supports independently switchable Pushover, Telegram and Zabbix notification channels.
  - Can re-apply receiver bandwidth / cEQ / iMS settings after watchdog-initiated tuning.
*/

const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const WebSocket = require('ws');

const { logInfo, logWarn, logError } = require('../../server/console');
const { serverConfig } = require('../../server/server_config');
const dataHandler = require('../../server/datahandler');
const pluginsApi = require('../../server/plugins_api');
const audioServer = require('../../server/stream/3las.server');

const PLUGIN_NAME = 'Pushover Watchdog';
const CONFIG_PATH = path.join(__dirname, '../../plugins_configs/PushoverWatchdog.json');
const RT_LOG_PATH = path.join(__dirname, '../../plugins_configs/PushoverWatchdog_RadioText.jsonl');
const RT_SEQUENCE_STATE_PATH = path.join(__dirname, '../../plugins_configs/PushoverWatchdog_RadioText_state.json');
const DBF_TO_DBUV_OFFSET = 11.25;
const DBF_TO_DBM_OFFSET = 120;
const MAX_PLUGIN_MESSAGE_BYTES = 65536;
const MAX_PUSHOVER_MESSAGE_CHARS = 950;
const MAX_TELEGRAM_MESSAGE_CHARS = 4000;
const MAX_FREQUENCIES = 64;
const MIN_TUNE_COMMAND_GAP_MS = 3000;
const MAX_NOTIFICATION_RESPONSE_BYTES = 32768;
const MAX_CONFIG_STRING_CHARS = 512;
const MAX_TEXT_WS_MESSAGE_BYTES = 262144;
const MAX_STATUS_STRING_CHARS = 128;
const RT_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RT_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_RT_LOG_PAGE_SIZE = 250;
const DEFAULT_RT_LOG_PAGE_SIZE = 100;
const MAX_RT_SEQUENCE_STATES = 256;
// Hard safety bounds: normal seven-day rolling retention remains unchanged, while
// malformed or abnormally noisy input cannot grow memory/disk without limit.
const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const MAX_RT_SEQUENCE_STATE_FILE_BYTES = 256 * 1024;
const MAX_RT_LOG_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RT_LOG_ENTRIES = 100000;
const MAX_STEREO_HISTORY_SAMPLES = 7200;
const PRIVATE_FILE_MODE = 0o600;
// FM-DX publishes RadioText progressively as characters are decoded. Wait until
// the active RT message has remained unchanged before writing it to history.
const RT_LOG_STABLE_MS = 4000;
const RT_LOG_MIN_STABLE_OBSERVATIONS = 2;
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

  pushoverEnabled: true,
  pushoverUserKey: '',
  pushoverApiToken: '',
  pushoverDevice: '',
  pushoverSound: 'pushover',
  pushoverPriority: 0,
  pushoverRetrySeconds: 60,
  pushoverExpireSeconds: 1800,

  telegramEnabled: false,
  telegramBotToken: '',
  telegramChatId: '',
  telegramThreadId: '',

  zabbixEnabled: false,
  zabbixServer: '',
  zabbixPort: 10051,
  zabbixHost: 'FM-DX Webserver',
  zabbixKey: 'fm_dx.watchdog.alert',

  radioTextLoggingEnabled: false,

  frequencies: ['91.600'],
  checkIntervalSeconds: 2,
  tuneSettleSeconds: 4,
  dwellSeconds: 30,
  forceRetuneSeconds: 10,
  forceRetuneBandwidthHz: 'keep',
  forceRetuneCeq: 'keep',
  forceRetuneIms: 'keep',

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
  merged.enabled = normalizeBoolean(merged.enabled, defaultConfig.enabled);
  merged.pushoverEnabled = normalizeBoolean(merged.pushoverEnabled, defaultConfig.pushoverEnabled);
  merged.telegramEnabled = normalizeBoolean(merged.telegramEnabled, defaultConfig.telegramEnabled);
  merged.zabbixEnabled = normalizeBoolean(merged.zabbixEnabled, defaultConfig.zabbixEnabled);
  merged.radioTextLoggingEnabled = normalizeBoolean(merged.radioTextLoggingEnabled, defaultConfig.radioTextLoggingEnabled);
  merged.requireCarrierForRds = normalizeBoolean(merged.requireCarrierForRds, defaultConfig.requireCarrierForRds);
  merged.requireCarrierForBlank = normalizeBoolean(merged.requireCarrierForBlank, defaultConfig.requireCarrierForBlank);
  merged.stereoMonitorEnabled = normalizeBoolean(merged.stereoMonitorEnabled, defaultConfig.stereoMonitorEnabled);
  merged.stereoRequireCarrier = normalizeBoolean(merged.stereoRequireCarrier, defaultConfig.stereoRequireCarrier);
  merged.stereoRequireAudio = normalizeBoolean(merged.stereoRequireAudio, defaultConfig.stereoRequireAudio);
  merged.stereoRequireRdsValid = normalizeBoolean(merged.stereoRequireRdsValid, defaultConfig.stereoRequireRdsValid);
  merged.sendRecoveryNotifications = normalizeBoolean(merged.sendRecoveryNotifications, defaultConfig.sendRecoveryNotifications);
  merged.includeRdsInfo = normalizeBoolean(merged.includeRdsInfo, defaultConfig.includeRdsInfo);
  merged.debugLogging = normalizeBoolean(merged.debugLogging, defaultConfig.debugLogging);
  merged.frequencies = normalizeFrequencies(merged.frequencies);
  merged.pushoverUserKey = cleanConfigString(merged.pushoverUserKey, 128);
  merged.pushoverApiToken = cleanConfigString(merged.pushoverApiToken, 128);
  merged.pushoverDevice = cleanConfigString(merged.pushoverDevice, 128);
  merged.pushoverSound = cleanConfigString(merged.pushoverSound, 64) || defaultConfig.pushoverSound;
  merged.telegramBotToken = cleanConfigString(merged.telegramBotToken, 256);
  merged.telegramChatId = cleanConfigString(merged.telegramChatId, 128);
  merged.telegramThreadId = cleanConfigString(merged.telegramThreadId, 32);
  merged.zabbixServer = cleanConfigString(merged.zabbixServer, 255);
  merged.zabbixHost = cleanConfigString(merged.zabbixHost, 255) || defaultConfig.zabbixHost;
  merged.zabbixKey = cleanConfigString(merged.zabbixKey, 255) || defaultConfig.zabbixKey;
  merged.zabbixPort = Math.trunc(positiveNumber(merged.zabbixPort, defaultConfig.zabbixPort, 1));
  if (merged.zabbixPort > 65535) merged.zabbixPort = defaultConfig.zabbixPort;
  merged.forceRetuneBandwidthHz = normalizeRetuneBandwidth(merged.forceRetuneBandwidthHz);
  merged.forceRetuneCeq = normalizeReceiverToggle(merged.forceRetuneCeq);
  merged.forceRetuneIms = normalizeReceiverToggle(merged.forceRetuneIms);
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

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return Boolean(fallback);
}

function normalizeRadioTextFlag(value) {
  const normalized = String(value ?? '').trim();
  if (normalized === '0') return 0;
  if (normalized === '1') return 1;
  return null;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveNumber(value, fallback, min) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function normalizeReceiverToggle(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'enabled' || v === 'disabled' ? v : 'keep';
}

function normalizeRetuneBandwidth(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === 'keep') return 'keep';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 500000 ? Math.round(n) : 'keep';
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
    bw: finiteNumber(raw.bw, NaN),
    eq: typeof raw.eq === 'boolean' || typeof raw.eq === 'number' ? raw.eq : safeStatusString(raw.eq, 8),
    ims: typeof raw.ims === 'boolean' || typeof raw.ims === 'number' ? raw.ims : safeStatusString(raw.ims, 8),
    rt0: safeStatusString(raw.rt0, 128),
    rt1: safeStatusString(raw.rt1, 128),
    rtFlag: normalizeRadioTextFlag(raw.rt_flag ?? raw.rtFlag)
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

function readBoundedUtf8File(filePath, maxBytes, description) {
  const size = fs.statSync(filePath).size;
  if (size > maxBytes) throw new Error(`${description} exceeds the safety limit of ${maxBytes} bytes.`);
  return fs.readFileSync(filePath, 'utf8');
}

function restrictPrivateFile(filePath) {
  if (process.platform === 'win32') return;
  try { fs.chmodSync(filePath, PRIVATE_FILE_MODE); } catch (_) {}
}

function writePrivateFileAtomic(filePath, contents) {
  // Keep transient files private and avoid a predictable temporary filename.
  // The exclusive create prevents overwriting an attacker-created symlink on
  // multi-user POSIX hosts where the configuration directory is writable.
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, contents, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
    restrictPrivateFile(tmpPath);
    fs.renameSync(tmpPath, filePath);
    restrictPrivateFile(filePath);
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

function appendPrivateUtf8File(filePath, contents) {
  // Preserve efficient append behaviour for the rolling log while refusing to
  // follow a substituted symbolic link on POSIX systems.
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow;
  let fd;
  try {
    fd = fs.openSync(filePath, flags, PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, contents, { encoding: 'utf8' });
  } catch (err) {
    if (err && (err.code === 'ELOOP' || err.code === 'EMLINK')) {
      throw new Error('Refused to append to a symbolic-link RadioText log path.');
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
  restrictPrivateFile(filePath);
}

function readConfigFile() {
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    const parsed = JSON.parse(readBoundedUtf8File(CONFIG_PATH, MAX_CONFIG_FILE_BYTES, 'Pushover Watchdog config')) || {};
    existing = isPlainObject(parsed) ? parsed : {};
    restrictPrivateFile(CONFIG_PATH);
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
  writePrivateFileAtomic(CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`);
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
    Number(oldConfig?.forceRetuneSeconds) !== Number(newConfig?.forceRetuneSeconds) ||
    String(oldConfig?.forceRetuneBandwidthHz) !== String(newConfig?.forceRetuneBandwidthHz) ||
    String(oldConfig?.forceRetuneCeq) !== String(newConfig?.forceRetuneCeq) ||
    String(oldConfig?.forceRetuneIms) !== String(newConfig?.forceRetuneIms);
}

function applyConfig(nextConfig, reason) {
  const previous = config;
  config = mergeAndNormalizeConfig(nextConfig);
  if (previous && configAffectsFrequencyLoop(previous, config)) {
    resetFrequencyStates();
  }
  if (previous && previous.radioTextLoggingEnabled !== config.radioTextLoggingEnabled) {
    // Pending progressive RT must not survive a logging toggle. The settled A/B
    // sequence state deliberately remains intact to avoid duplicate entries.
    clearPendingRadioTextCandidate();
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
  // FM-DX broadcasts client-originated /data_plugins messages to other plugin
  // clients. Never accept or transport high-value notification secrets in the
  // browser save payload; retain credentials from the latest valid server-side
  // config. Reading once here avoids overwriting a token that an administrator
  // has just edited directly before fs.watch/polling has reloaded it.
  const uiUpdate = isPlainObject(newConfig) ? { ...newConfig } : {};
  delete uiUpdate.pushoverUserKey;
  delete uiUpdate.pushoverApiToken;
  delete uiUpdate.telegramBotToken;
  let secretSource = config;
  try {
    secretSource = readConfigFile();
  } catch (err) {
    logWarn(`[${PLUGIN_NAME}] UI save kept the loaded notification credentials because the on-disk config was not valid at save time: ${err.message}`);
  }
  const merged = mergeAndNormalizeConfig({
    ...uiUpdate,
    pushoverUserKey: secretSource.pushoverUserKey,
    pushoverApiToken: secretSource.pushoverApiToken,
    telegramBotToken: secretSource.telegramBotToken
  });
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
let radioTextLogEntries = [];
// RadioText commonly alternates between two RDS A/B sequences (for example,
// now-playing text and a station/promo message). Keep the latest settled value
// for each sequence separately so that returning to an unchanged A or B text
// is not recorded as a new event.
let lastSettledRtBySequence = new Map();
let lastRtLogPruneAt = 0;
let pendingRtCandidate = null;
let pendingRtTimer = null;

function normalizeRadioTextLogEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const timestamp = String(raw.timestamp || '');
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  const rt = safeStatusString(raw.rt, 256);
  if (!isNonEmptyText(rt)) return null;
  return {
    timestamp: new Date(timestampMs).toISOString(),
    frequency: frequencyKey(raw.frequency),
    pi: safeStatusString(raw.pi, 16),
    ps: safeStatusString(raw.ps, 16),
    rt,
    rt0: safeStatusString(raw.rt0, 128),
    rt1: safeStatusString(raw.rt1, 128),
    rtFlag: normalizeRadioTextFlag(raw.rtFlag ?? raw.rt_flag)
  };
}

function rewriteRadioTextLog() {
  const dir = path.dirname(RT_LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const body = radioTextLogEntries.map(entry => JSON.stringify(entry)).join('\n');
  writePrivateFileAtomic(RT_LOG_PATH, body ? `${body}\n` : '');
}

function readRadioTextLogBounded() {
  const size = fs.statSync(RT_LOG_PATH).size;
  if (size <= MAX_RT_LOG_FILE_BYTES) {
    restrictPrivateFile(RT_LOG_PATH);
    return fs.readFileSync(RT_LOG_PATH, 'utf8');
  }
  const fd = fs.openSync(RT_LOG_PATH, 'r');
  try {
    const start = size - MAX_RT_LOG_FILE_BYTES;
    const buffer = Buffer.alloc(MAX_RT_LOG_FILE_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
    let tail = buffer.subarray(0, bytesRead).toString('utf8');
    const firstNewLine = tail.indexOf('\n');
    tail = firstNewLine >= 0 ? tail.slice(firstNewLine + 1) : '';
    logWarn(`[${PLUGIN_NAME}] RadioText log exceeded the memory safety cap; only the most recent bounded tail was retained.`);
    return tail;
  } finally {
    fs.closeSync(fd);
    restrictPrivateFile(RT_LOG_PATH);
  }
}

function pruneRadioTextLog(now = Date.now(), forceRewrite = false) {
  const cutoff = now - RT_LOG_RETENTION_MS;
  const previousLength = radioTextLogEntries.length;
  radioTextLogEntries = radioTextLogEntries.filter(entry => Date.parse(entry.timestamp) >= cutoff);
  if (radioTextLogEntries.length > MAX_RT_LOG_ENTRIES) {
    radioTextLogEntries = radioTextLogEntries.slice(-MAX_RT_LOG_ENTRIES);
    logWarn(`[${PLUGIN_NAME}] RadioText log reached the safety entry cap; oldest retained entries were discarded.`);
  }
  if (forceRewrite || radioTextLogEntries.length !== previousLength) rewriteRadioTextLog();
  lastRtLogPruneAt = now;
}

function loadRadioTextLog() {
  try {
    if (!fs.existsSync(RT_LOG_PATH)) {
      radioTextLogEntries = [];
      rewriteRadioTextLog();
      return;
    }
    radioTextLogEntries = readRadioTextLogBounded()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try { return normalizeRadioTextLogEntry(JSON.parse(line)); } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    pruneRadioTextLog(Date.now(), true);
  } catch (err) {
    radioTextLogEntries = [];
    logWarn(`[${PLUGIN_NAME}] RadioText log could not be loaded: ${err.message}`);
  }
}

function currentRadioText(data) {
  const rt0 = isNonEmptyText(data?.rt0) ? String(data.rt0).trim() : '';
  const rt1 = isNonEmptyText(data?.rt1) ? String(data.rt1).trim() : '';
  const rtFlag = normalizeRadioTextFlag(data?.rtFlag ?? data?.rt_flag);

  // FM-DX exposes RT A/B as rt0 and rt1 and identifies the active message via
  // rt_flag. Never join the old and current buffers into one logged event.
  let rt = '';
  if (rtFlag === 0) rt = rt0;
  else if (rtFlag === 1) rt = rt1;
  else rt = rt0 || rt1; // compatibility fallback for payloads without rt_flag

  return { rt, rt0, rt1, rtFlag };
}

function radioTextSignature(frequency, pi, ps, rt) {
  // The signature represents the fully settled text for one station.
  return [
    frequencyKey(frequency),
    safeStatusString(pi, 16),
    safeStatusString(ps, 16),
    safeStatusString(rt, 256)
  ].join('|');
}

function radioTextSequenceKey(frequency, pi, ps, rtFlag) {
  const normalizedFlag = normalizeRadioTextFlag(rtFlag);
  const safePi = safeStatusString(pi, 16);
  const safePs = safeStatusString(ps, 16);
  const identity = safePi ? `pi:${safePi}` : `ps:${safePs}`;
  const sequence = normalizedFlag === null ? 'single' : `rt${normalizedFlag}`;
  return [frequencyKey(frequency), identity, sequence].join('|');
}

function rememberSettledRadioTextSequence(sequenceKey, signature) {
  if (!isNonEmptyText(sequenceKey) || !isNonEmptyText(signature)) return;
  // Refresh insertion order so an unusually large set of monitored services can
  // be bounded without retaining stale receiver state forever.
  lastSettledRtBySequence.delete(sequenceKey);
  lastSettledRtBySequence.set(sequenceKey, signature);
  while (lastSettledRtBySequence.size > MAX_RT_SEQUENCE_STATES) {
    lastSettledRtBySequence.delete(lastSettledRtBySequence.keys().next().value);
  }
}

function writeRadioTextSequenceState() {
  try {
    const dir = path.dirname(RT_SEQUENCE_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const body = {
      version: 1,
      sequences: Object.fromEntries(lastSettledRtBySequence)
    };
    writePrivateFileAtomic(RT_SEQUENCE_STATE_PATH, `${JSON.stringify(body, null, 2)}\n`);
  } catch (err) {
    logWarn(`[${PLUGIN_NAME}] RadioText sequence state could not be written: ${err.message}`);
  }
}

function rebuildRadioTextSequenceStateFromRetainedLog() {
  lastSettledRtBySequence = new Map();
  for (const entry of radioTextLogEntries) {
    const key = radioTextSequenceKey(entry.frequency, entry.pi, entry.ps, entry.rtFlag);
    const signature = radioTextSignature(entry.frequency, entry.pi, entry.ps, entry.rt);
    rememberSettledRadioTextSequence(key, signature);
  }
}

function loadRadioTextSequenceState() {
  try {
    if (fs.existsSync(RT_SEQUENCE_STATE_PATH)) {
      const parsed = JSON.parse(readBoundedUtf8File(RT_SEQUENCE_STATE_PATH, MAX_RT_SEQUENCE_STATE_FILE_BYTES, 'RadioText sequence state'));
      restrictPrivateFile(RT_SEQUENCE_STATE_PATH);
      if (isPlainObject(parsed) && isPlainObject(parsed.sequences)) {
        lastSettledRtBySequence = new Map();
        for (const [key, signature] of Object.entries(parsed.sequences)) {
          if (isNonEmptyText(key) && isNonEmptyText(signature)) {
            rememberSettledRadioTextSequence(key, signature);
          }
        }
        return;
      }
    }
  } catch (err) {
    logWarn(`[${PLUGIN_NAME}] RadioText sequence state could not be loaded: ${err.message}`);
  }
  // Existing installations do not yet have a state file. Seed the sequence
  // tracker from retained history so the upgrade does not immediately repeat
  // the most recently recorded A/B texts.
  rebuildRadioTextSequenceStateFromRetainedLog();
  writeRadioTextSequenceState();
}

function clearPendingRadioTextCandidate() {
  runtimeClearTimer(pendingRtTimer);
  pendingRtTimer = null;
  pendingRtCandidate = null;
}

runtimeAddCleanup(clearPendingRadioTextCandidate);

function appendFinalRadioTextEntry(candidate) {
  if (!candidate) return;
  if (lastSettledRtBySequence.get(candidate.sequenceKey) === candidate.signature) return;
  const entry = {
    timestamp: new Date().toISOString(),
    frequency: candidate.frequency,
    pi: candidate.pi,
    ps: candidate.ps,
    rt: candidate.rt,
    rt0: candidate.rt0,
    rt1: candidate.rt1,
    rtFlag: candidate.rtFlag
  };

  try {
    appendPrivateUtf8File(RT_LOG_PATH, `${JSON.stringify(entry)}\n`);
    radioTextLogEntries.push(entry);
    rememberSettledRadioTextSequence(candidate.sequenceKey, candidate.signature);
    writeRadioTextSequenceState();
    if (radioTextLogEntries.length > MAX_RT_LOG_ENTRIES || !lastRtLogPruneAt || Date.now() - lastRtLogPruneAt >= RT_LOG_CLEANUP_INTERVAL_MS) {
      pruneRadioTextLog(Date.now(), true);
    }
    sendPluginMessage('PushoverWatchdog:rtLogChanged', { latest: entry });
  } catch (err) {
    logWarn(`[${PLUGIN_NAME}] RadioText log write failed: ${err.message}`);
  }
}

function commitPendingRadioTextCandidate(expectedSignature) {
  pendingRtTimer = null;
  const candidate = pendingRtCandidate;
  if (!candidate || candidate.signature !== expectedSignature) return;
  if (candidate.confirmations < RT_LOG_MIN_STABLE_OBSERVATIONS) {
    clearPendingRadioTextCandidate();
    return;
  }

  const latestData = lastData;
  const latestText = currentRadioText(latestData);
  const latestSignature = radioTextSignature(latestData?.freq, latestData?.pi, latestData?.ps, latestText.rt);
  if (!config.radioTextLoggingEnabled || !isRdsPresent(latestData) || !hasValidRdsIdentity(latestData) || latestSignature !== expectedSignature) {
    clearPendingRadioTextCandidate();
    return;
  }

  appendFinalRadioTextEntry(candidate);
  clearPendingRadioTextCandidate();
}

function recordRadioTextIfChanged(data) {
  if (!config.radioTextLoggingEnabled || !data || !isRdsPresent(data) || !hasValidRdsIdentity(data)) {
    clearPendingRadioTextCandidate();
    return;
  }

  const text = currentRadioText(data);
  if (!isNonEmptyText(text.rt)) {
    clearPendingRadioTextCandidate();
    return;
  }

  const signature = radioTextSignature(data.freq, data.pi, data.ps, text.rt);
  const sequenceKey = radioTextSequenceKey(data.freq, data.pi, data.ps, text.rtFlag);
  if (lastSettledRtBySequence.get(sequenceKey) === signature) {
    clearPendingRadioTextCandidate();
    return;
  }

  const candidate = {
    signature,
    sequenceKey,
    frequency: frequencyKey(data.freq),
    pi: safeStatusString(data.pi, 16),
    ps: safeStatusString(data.ps, 16),
    rt: safeStatusString(text.rt, 256),
    rt0: safeStatusString(text.rt0, 128),
    rt1: safeStatusString(text.rt1, 128),
    rtFlag: text.rtFlag,
    confirmations: 1
  };

  if (pendingRtCandidate && pendingRtCandidate.signature === signature) {
    pendingRtCandidate = { ...candidate, confirmations: pendingRtCandidate.confirmations + 1 };
    return;
  }

  clearPendingRadioTextCandidate();
  pendingRtCandidate = candidate;
  pendingRtTimer = runtimeSetTimeout(() => commitPendingRadioTextCandidate(signature), RT_LOG_STABLE_MS);
}

function radioTextLogPage(request = {}) {
  pruneRadioTextLog(Date.now(), false);
  const requestedLimit = Math.trunc(finiteNumber(request.limit, DEFAULT_RT_LOG_PAGE_SIZE));
  const limit = Math.max(1, Math.min(MAX_RT_LOG_PAGE_SIZE, requestedLimit));
  const parsedBefore = request.before ? Date.parse(String(request.before)) : Infinity;
  const beforeMs = Number.isFinite(parsedBefore) ? parsedBefore : Infinity;
  const entries = [];
  let hasMore = false;
  // Entries are maintained chronologically; walk backwards and stop as soon as
  // the requested page is full rather than copying/sorting the complete history.
  for (let index = radioTextLogEntries.length - 1; index >= 0; index -= 1) {
    const entry = radioTextLogEntries[index];
    if (Date.parse(entry.timestamp) >= beforeMs) continue;
    if (entries.length < limit) entries.push(entry);
    else {
      hasMore = true;
      break;
    }
  }
  return {
    entries,
    retentionDays: 7,
    hasMore,
    nextBefore: entries.length ? entries[entries.length - 1].timestamp : null
  };
}

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
  return type === 'PushoverWatchdog:config' ||
    type === 'PushoverWatchdog:status' ||
    type === 'PushoverWatchdog:toast' ||
    type === 'PushoverWatchdog:rtLogPage' ||
    type === 'PushoverWatchdog:rtLogChanged';
}

function sendPluginMessage(type, value) {
  const payload = JSON.stringify({ type, value });
  const sensitive = isSensitivePluginMessage(type);
  const wss = pluginsApi.getPluginsWss();
  if (wss) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && (!sensitive || client.__pushoverWatchdogAdminAuthenticated === true)) {
        try { client.send(payload); } catch (_) {}
      }
    });
  }
}

function sendPluginMessageTo(client, type, value) {
  if (!client || client.readyState !== WebSocket.OPEN) return;
  try { client.send(JSON.stringify({ type, value })); } catch (_) {}
}

function isAdminAuthenticatedWs(client) {
  return client && client.__pushoverWatchdogAdminAuthenticated === true;
}

function rejectUnauthenticated(client, action) {
  sendPluginMessageTo(client, 'PushoverWatchdog:toast', {
    level: 'error',
    message: `Administrator login required to ${action}.`
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
      recordRadioTextIfChanged(lastData);
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

const pluginClientMessageHandlers = new Map();

function detachPluginClientMessageHandlers() {
  for (const [client, handlers] of pluginClientMessageHandlers.entries()) {
    try { client.off('message', handlers.message); } catch (_) {}
    try { client.off('close', handlers.close); } catch (_) {}
  }
  pluginClientMessageHandlers.clear();
}

runtimeAddCleanup(detachPluginClientMessageHandlers);

function registerPluginWebSocketAuthHandlers() {
  const wss = pluginsApi.getPluginsWss();
  if (!wss) {
    runtimeSetTimeout(registerPluginWebSocketAuthHandlers, 1000);
    return;
  }

  const connectionHandler = (client, request) => {
    const originAllowed = isAllowedWebSocketOrigin(request);
    client.__pushoverWatchdogAdminAuthenticated = !!(originAllowed && request.session?.isAdminAuthenticated);
    if (!originAllowed) logWarn(`[${PLUGIN_NAME}] Rejected plugin WebSocket actions due to invalid Origin header.`);

    const messageHandler = (message) => {
      if (Buffer.byteLength(message) > MAX_PLUGIN_MESSAGE_BYTES) {
        logWarn(`[${PLUGIN_NAME}] Ignored oversized plugin WebSocket message.`);
        return;
      }
      let event;
      try { event = JSON.parse(message.toString()); } catch (_) { return; }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
      if (!event.type.startsWith('PushoverWatchdog:')) return;

      if (event.type === 'PushoverWatchdog:getConfig') {
        if (!isAdminAuthenticatedWs(client)) return rejectUnauthenticated(client, 'view Pushover Watchdog settings');
        sendPluginMessageTo(client, 'PushoverWatchdog:config', sanitizedConfigForUi());
        return;
      }

      if (event.type === 'PushoverWatchdog:getRtLog') {
        if (!isAdminAuthenticatedWs(client)) return rejectUnauthenticated(client, 'view RadioText log');
        sendPluginMessageTo(client, 'PushoverWatchdog:rtLogPage', radioTextLogPage(isPlainObject(event.value) ? event.value : {}));
        return;
      }

      if (event.type === 'PushoverWatchdog:saveConfig') {
        if (!isAdminAuthenticatedWs(client)) return rejectUnauthenticated(client, 'save Pushover Watchdog settings');
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

      if (event.type === 'PushoverWatchdog:test' || event.type === 'PushoverWatchdog:testChannel') {
        if (!isAdminAuthenticatedWs(client)) return rejectUnauthenticated(client, 'send FM Monitor test notifications');
        const channel = event.type === 'PushoverWatchdog:test' ? 'pushover' : String(event.value?.channel || '').toLowerCase();
        sendTestNotification(channel)
          .then(() => sendPluginMessageTo(client, 'PushoverWatchdog:toast', { level: 'success', message: `${channelLabel(channel)} test notification sent.` }))
          .catch(err => sendPluginMessageTo(client, 'PushoverWatchdog:toast', { level: 'error', message: `${channelLabel(channel)} test failed: ${err.message}` }));
        return;
      }
    };
    const closeHandler = () => pluginClientMessageHandlers.delete(client);
    pluginClientMessageHandlers.set(client, { message: messageHandler, close: closeHandler });
    client.on('message', messageHandler);
    client.once('close', closeHandler);
  };

  wss.on('connection', connectionHandler);
  runtimeAddCleanup(() => {
    try { wss.off('connection', connectionHandler); } catch (_) {}
  });

  logInfo(`[${PLUGIN_NAME}] Administrator-only WebSocket protection enabled.`);
}

function sanitizedConfigForUi(cfg = config) {
  const visible = { ...cfg };
  // Credentials are never transmitted through /data_plugins; FM-DX broadcasts
  // browser-originated plugin messages to other connected plugin clients.
  delete visible.pushoverUserKey;
  delete visible.pushoverApiToken;
  delete visible.telegramBotToken;
  visible.pushoverCredentialsConfigured = !!(cfg.pushoverUserKey && cfg.pushoverApiToken);
  visible.telegramBotConfigured = !!cfg.telegramBotToken;
  return visible;
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

function receiverBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'enabled') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'disabled') return false;
  return null;
}

function applyReceiverOptionsAfterTune(reason) {
  const commands = [];
  if (config.forceRetuneBandwidthHz !== 'keep') {
    commands.push(`W${config.forceRetuneBandwidthHz}`);
  }

  if (config.forceRetuneCeq !== 'keep' || config.forceRetuneIms !== 'keep') {
    const d = lastData || sanitizeReceiverData(dataHandler.dataToSend) || {};
    const observedCeq = receiverBoolean(d.eq);
    const observedIms = receiverBoolean(d.ims);
    if ((config.forceRetuneCeq === 'keep' && observedCeq === null) || (config.forceRetuneIms === 'keep' && observedIms === null)) {
      logWarn(`[${PLUGIN_NAME}] Skipped cEQ/iMS retune option because the existing state could not be preserved.`);
    } else {
      const ceq = config.forceRetuneCeq === 'keep' ? observedCeq : config.forceRetuneCeq === 'enabled';
      const ims = config.forceRetuneIms === 'keep' ? observedIms : config.forceRetuneIms === 'enabled';
      commands.push(`G${ceq ? '1' : '0'}${ims ? '1' : '0'}`);
    }
  }

  for (const command of commands) {
    Promise.resolve(pluginsApi.sendPrivilegedCommand(command, true))
      .then(ok => {
        if (ok) logDebug(`Applied receiver option ${command} after tune (${reason}).`);
        else logWarn(`[${PLUGIN_NAME}] Could not apply receiver option ${command} after tune (${reason}).`);
      })
      .catch(err => logWarn(`[${PLUGIN_NAME}] Receiver option command ${command} failed after tune (${reason}): ${err.message}`));
  }
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
      if (ok) {
        logDebug(`Tuned to ${key} MHz (${reason})`);
        applyReceiverOptionsAfterTune(reason);
      } else {
        logWarn(`[${PLUGIN_NAME}] Could not tune to ${key} MHz (${reason}).`);
      }
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
    bw: d.bw,
    eq: d.eq,
    ims: d.ims,
    radioTextLoggingEnabled: !!config.radioTextLoggingEnabled,
    radioTextLogCount: radioTextLogEntries.length,
    audioDbfs: Number.isFinite(currentAudio.dbfs) ? Number(currentAudio.dbfs.toFixed(1)) : null,
    audioAttached: currentAudio.attached,
    audioAgeSeconds: currentAudio.lastUpdate ? Number(((Date.now() - currentAudio.lastUpdate) / 1000).toFixed(1)) : null,
    enabled: !!config.enabled
  };
}

function tick() {
  const now = Date.now();

  if (!config.enabled) {
    if (lastAudioStream || currentAudio.attached) detachAudioMonitor();
    sendPluginMessage('PushoverWatchdog:status', currentStatusPayload());
    return;
  }

  attachAudioMonitor();

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
  if (st.stereoHistory.length > MAX_STEREO_HISTORY_SAMPLES) {
    st.stereoHistory = st.stereoHistory.slice(-MAX_STEREO_HISTORY_SAMPLES);
  }

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

  dispatchNotifications(titleMap[kind] || 'FM-DX Watchdog', message, kind, freq);
}

function channelLabel(channel) {
  const names = { pushover: 'Pushover', telegram: 'Telegram', zabbix: 'Zabbix' };
  return names[channel] || 'Notification channel';
}

function notificationPayload(title, message, kind, freq) {
  return {
    title,
    message,
    kind,
    frequency: Number.isFinite(Number(freq)) ? frequencyKey(freq) : '',
    timestamp: new Date().toISOString()
  };
}

function sendTestNotification(channel) {
  const title = 'FM-DX Watchdog test';
  const message = 'Test notification from FM Monitor.';
  if (channel === 'pushover') return sendPushover(title, message, 'test');
  if (channel === 'telegram') return sendTelegram(title, message, 'test');
  if (channel === 'zabbix') return sendZabbix(title, message, 'test');
  return Promise.reject(new Error('Unknown notification channel.'));
}

function dispatchNotifications(title, message, kind, freq) {
  const tasks = [];
  if (config.pushoverEnabled) tasks.push({ channel: 'pushover', promise: sendPushover(title, message, kind) });
  if (config.telegramEnabled) tasks.push({ channel: 'telegram', promise: sendTelegram(title, message, kind) });
  if (config.zabbixEnabled) tasks.push({ channel: 'zabbix', promise: sendZabbix(title, message, kind, freq) });
  if (!tasks.length) {
    logDebug(`Alert ${kind} was detected, but all notification channels are disabled.`);
    return;
  }
  for (const task of tasks) {
    task.promise
      .then(() => logInfo(`[${PLUGIN_NAME}] ${channelLabel(task.channel)} alert sent: ${kind}${Number.isFinite(Number(freq)) ? ` ${frequencyKey(freq)} MHz` : ''}.`))
      .catch(err => logError(`[${PLUGIN_NAME}] ${channelLabel(task.channel)} alert failed: ${err.message}`));
  }
}

function truncateText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function sendPushover(title, message, kind) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    if (!config.pushoverUserKey || !config.pushoverApiToken) {
      finish(new Error('Pushover User Key or API Token is missing.'));
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
        if (responseBytes <= MAX_NOTIFICATION_RESPONSE_BYTES) {
          response += chunk.toString();
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) finish(null, response);
        else finish(new Error(`HTTP ${res.statusCode}: ${truncateText(response, 512)}`));
      });
      res.on('aborted', () => finish(new Error('Pushover response was aborted before completion.')));
      res.on('error', err => finish(err));
    });
    req.on('timeout', () => req.destroy(new Error('Pushover request timeout')));
    req.on('error', err => finish(err));
    req.write(body);
    req.end();
  });
}

function sendTelegram(title, message, kind) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    if (!config.telegramBotToken || !config.telegramChatId) {
      finish(new Error('Telegram Bot Token or Chat ID is missing.'));
      return;
    }
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(config.telegramBotToken)) {
      finish(new Error('Telegram Bot Token format is invalid.'));
      return;
    }

    const payload = new URLSearchParams();
    payload.set('chat_id', config.telegramChatId);
    payload.set('text', truncateText(`${title}\n\n${message}`, MAX_TELEGRAM_MESSAGE_CHARS));
    payload.set('disable_web_page_preview', 'true');
    if (config.telegramThreadId) payload.set('message_thread_id', config.telegramThreadId);

    const body = payload.toString();
    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${config.telegramBotToken}/sendMessage`,
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
        if (responseBytes <= MAX_NOTIFICATION_RESPONSE_BYTES) response += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) finish(null, response);
        else finish(new Error(`HTTP ${res.statusCode}: ${truncateText(response, 512)}`));
      });
      res.on('aborted', () => finish(new Error('Telegram response was aborted before completion.')));
      res.on('error', err => finish(err));
    });
    req.on('timeout', () => req.destroy(new Error('Telegram request timeout')));
    req.on('error', err => finish(err));
    req.write(body);
    req.end();
  });
}

function sendZabbix(title, message, kind, freq) {
  return new Promise((resolve, reject) => {
    if (!config.zabbixServer || !config.zabbixHost || !config.zabbixKey) {
      reject(new Error('Zabbix server, host name or trapper key is missing.'));
      return;
    }

    const event = notificationPayload(title, message, kind, freq);
    const requestPayload = Buffer.from(JSON.stringify({
      request: 'sender data',
      data: [{
        host: config.zabbixHost,
        key: config.zabbixKey,
        value: JSON.stringify(event),
        clock: Math.floor(Date.now() / 1000)
      }]
    }), 'utf8');
    const header = Buffer.alloc(13);
    header.write('ZBXD\x01', 0, 'binary');
    header.writeBigUInt64LE(BigInt(requestPayload.length), 5);
    const socket = net.createConnection({ host: config.zabbixServer, port: config.zabbixPort });
    let response = Buffer.alloc(0);
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      if (error) reject(error); else resolve(value);
    };

    const parseResponseIfComplete = () => {
      if (response.length < 13 || response.subarray(0, 5).toString('binary') !== 'ZBXD\x01') return false;
      const expectedLength = Number(response.readBigUInt64LE(5));
      if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > MAX_NOTIFICATION_RESPONSE_BYTES) {
        finish(new Error('Invalid or oversized Zabbix response.'));
        return true;
      }
      if (response.length < 13 + expectedLength) return false;
      try {
        const body = response.subarray(13, 13 + expectedLength).toString('utf8');
        const parsed = body ? JSON.parse(body) : {};
        const failed = typeof parsed.info === 'string'
          ? Number((parsed.info.match(/failed:\s*(\d+)/i) || [])[1] || 0)
          : 0;
        if (parsed.response !== 'success' || failed > 0) {
          finish(new Error(`Zabbix rejected data: ${truncateText(parsed.info || body, 512)}`));
        } else {
          finish(null, parsed);
        }
      } catch (err) {
        finish(new Error(`Invalid Zabbix response: ${err.message}`));
      }
      return true;
    };

    socket.setTimeout(10000);
    socket.on('connect', () => socket.write(Buffer.concat([header, requestPayload])));
    socket.on('data', chunk => {
      if (response.length + chunk.length > MAX_NOTIFICATION_RESPONSE_BYTES + 13) {
        finish(new Error('Oversized Zabbix response.'));
        return;
      }
      response = Buffer.concat([response, chunk]);
      parseResponseIfComplete();
    });
    socket.on('end', () => {
      if (!settled && !parseResponseIfComplete()) {
        finish(new Error('Incomplete Zabbix response.'));
      }
    });
    socket.on('timeout', () => finish(new Error('Zabbix connection timeout')));
    socket.on('error', err => finish(err));
    socket.on('close', () => {
      if (!settled) finish(new Error('Zabbix connection closed before a complete response.'));
    });
  });
}

loadRadioTextLog();
loadRadioTextSequenceState();
startConfigHotReload();
connectTextWebSocket();
registerPluginWebSocketAuthHandlers();
runtimeSetInterval(tick, 1000);
runtimeSetInterval(() => pruneRadioTextLog(Date.now(), true), RT_LOG_CLEANUP_INTERVAL_MS);

logInfo(`[${PLUGIN_NAME}] Loaded. Config: ${CONFIG_PATH}`);
