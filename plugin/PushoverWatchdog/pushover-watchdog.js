'use strict';

(() => {
  const runtimeKey = '__PushoverWatchdogFrontendRuntime';
  if (window[runtimeKey] && typeof window[runtimeKey].stop === 'function') {
    try { window[runtimeKey].stop(); } catch (_) {}
  }
  const runtime = {
    timers: new Set(),
    observers: new Set(),
    stopped: false,
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      for (const timer of this.timers) {
        try { clearTimeout(timer); clearInterval(timer); } catch (_) {}
      }
      this.timers.clear();
      for (const observer of this.observers) {
        try { observer.disconnect(); } catch (_) {}
      }
      this.observers.clear();
      try { document.removeEventListener('DOMContentLoaded', boot); } catch (_) {}
      // Share logout teardown so retired copies release socket, UI and log data.
      deactivateAdminUi();
    }
  };
  window[runtimeKey] = runtime;

  function runtimeSetTimeout(fn, delay) {
    if (runtime.stopped) return null;
    const timer = setTimeout(() => {
      runtime.timers.delete(timer);
      if (!runtime.stopped) fn();
    }, delay);
    runtime.timers.add(timer);
    return timer;
  }

  function runtimeSetInterval(fn, delay) {
    if (runtime.stopped) return null;
    const timer = setInterval(() => {
      if (!runtime.stopped) fn();
    }, delay);
    runtime.timers.add(timer);
    return timer;
  }

  function runtimeClearTimer(timer) {
    if (!timer) return;
    clearTimeout(timer);
    clearInterval(timer);
    runtime.timers.delete(timer);
  }

  const pluginName = 'Pushover Watchdog';
  const pluginVersion = '1.0.5';
  const pluginAuthor = 'by Play Radio Constanta';
  const maxPluginMessageBytes = 65536;
  const maxRtLogPageSize = 250;
  const adminSessionCheckMs = 5000;
  let config = null;
  let status = null;
  let ws = null;
  let wsReconnectTimer = null;
  let channelToken = null;
  let rtLogEntries = [];
  let rtLogHasMore = false;
  let rtLogBefore = null;
  let rtLogAppendNext = false;

  function wsUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${window.location.pathname}data_plugins`;
  }

  function isAdminAuthenticated() {
    // Prefer the dedicated admin control because it avoids scanning the complete
    // dashboard text on the common authenticated path. Keep the text fallback for
    // FM-DX builds/themes where that control is not present.
    if (document.querySelector('#dashboard-lock-admin')) return true;
    const bodyText = document.body ? (document.body.textContent || document.body.innerText || '') : '';
    return bodyText.includes('You are logged in as an administrator.') ||
      bodyText.includes('You are logged in as an adminstrator.');
  }

  function connect() {
    if (runtime.stopped || !isAdminAuthenticated()) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (wsReconnectTimer) {
      runtimeClearTimer(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    const socket = new WebSocket(wsUrl());
    ws = socket;
    socket.addEventListener('open', () => {
      if (runtime.stopped || ws !== socket || !isAdminAuthenticated()) return;
      send('PushoverWatchdog:getConfig', {});
    });
    socket.addEventListener('message', (event) => {
      if (runtime.stopped || ws !== socket || !isAdminAuthenticated()) return;
      if (typeof event.data !== 'string' || event.data.length > maxPluginMessageBytes) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!isPlainObject(msg) || typeof msg.type !== 'string') return;

      if (msg.type === 'PushoverWatchdog:channel') {
        const token = isPlainObject(msg.value) ? String(msg.value.token || '') : '';
        if (!channelToken && /^[A-Za-z0-9_-]{32,128}$/.test(token)) channelToken = token;
        return;
      }
      // FM-DX's /data_plugins endpoint rebroadcasts browser-originated plugin
      // messages to every plugin client. Accept privileged plugin responses only
      // when they carry the per-connection token issued directly by the backend.
      if (!channelToken || msg.channelToken !== channelToken) return;

      if (msg.type === 'PushoverWatchdog:config') {
        if (!isPlainObject(msg.value)) return;
        config = msg.value;
        renderModal();
      }
      if (msg.type === 'PushoverWatchdog:status') {
        if (!isPlainObject(msg.value)) return;
        status = msg.value;
        renderStatus();
      }
      if (msg.type === 'PushoverWatchdog:rtLogPage') {
        if (!isPlainObject(msg.value)) return;
        applyRtLogPage(msg.value);
      }
      if (msg.type === 'PushoverWatchdog:rtLogChanged') {
        const rtLogModal = document.getElementById('pushover-watchdog-rtlog-modal');
        if (rtLogModal && !rtLogModal.classList.contains('hidden')) requestRtLog(true);
      }
      if (msg.type === 'PushoverWatchdog:toast') {
        if (!isPlainObject(msg.value)) return;
        toast(msg.value.level || 'info', msg.value.message || 'Pushover Watchdog update');
      }
    });
    socket.addEventListener('close', () => {
      if (ws !== socket) return;
      ws = null;
      channelToken = null;
      if (runtime.stopped || !isAdminAuthenticated()) return;
      if (!wsReconnectTimer) {
        wsReconnectTimer = runtimeSetTimeout(() => {
          wsReconnectTimer = null;
          connect();
        }, 5000);
      }
    });
  }

  function send(type, value) {
    const payload = JSON.stringify({ type, value });
    if (runtime.stopped || !isAdminAuthenticated()) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch (_) {}
    }
  }

  function toast(level, message) {
    if (typeof sendToast === 'function') {
      const cls = level === 'error' ? 'error' : level === 'success' ? 'success important' : 'info';
      sendToast(cls, pluginName, safeText(message, 300), false, false);
    } else {
      console.log(`${pluginName}: ${safeText(message, 300)}`);
    }
  }

  function safeText(value, maxChars = 512) {
    return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, Math.max(0, maxChars));
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function field(id, label, value, type = 'text', help = '') {
    return `
      <label class="pwd-field">
        <span>${label}</span>
        <input id="${id}" type="${type}" value="${escapeHtml(value ?? '')}">
        ${help ? `<small>${help}</small>` : ''}
      </label>`;
  }

  function protectedSecretField(label, configured, configKeys) {
    const state = configured ? 'Configured on server' : 'Not configured';
    return `
      <div class="pwd-field">
        <span>${label}</span>
        <div class="pwd-secret-status">${escapeHtml(state)}</div>
        <small>For security, edit <code>plugins_configs/PushoverWatchdog.json</code> directly (${escapeHtml(configKeys)}). Secrets are not sent through the plugin WebSocket.</small>
      </div>`;
  }

  function checkbox(id, label, value) {
    return `
      <label class="pwd-check">
        <input id="${id}" type="checkbox" ${value ? 'checked' : ''}>
        <span>${label}</span>
      </label>`;
  }

  function receiverToggleSelect(id, label, value, help = '') {
    const selected = ['enabled', 'disabled'].includes(String(value)) ? String(value) : 'keep';
    return `
      <label class="pwd-field">
        <span>${label}</span>
        <select id="${id}">
          <option value="keep" ${selected === 'keep' ? 'selected' : ''}>Keep current setting</option>
          <option value="enabled" ${selected === 'enabled' ? 'selected' : ''}>Enabled</option>
          <option value="disabled" ${selected === 'disabled' ? 'selected' : ''}>Disabled</option>
        </select>
        ${help ? `<small>${help}</small>` : ''}
      </label>`;
  }

  function bandwidthSelect(value) {
    const selected = String(value ?? 'keep');
    const bandwidths = [
      ['keep', 'Keep current setting'],
      ['0', 'Auto'],
      ['56000', '56 kHz'], ['64000', '64 kHz'], ['72000', '72 kHz'],
      ['84000', '84 kHz'], ['97000', '97 kHz'], ['114000', '114 kHz'],
      ['133000', '133 kHz'], ['151000', '151 kHz'], ['184000', '184 kHz'],
      ['200000', '200 kHz'], ['217000', '217 kHz'], ['236000', '236 kHz'],
      ['254000', '254 kHz'], ['287000', '287 kHz'], ['311000', '311 kHz']
    ];
    return `
      <label class="pwd-field">
        <span>Bandwidth after watchdog tune / retune</span>
        <select id="pwd-force-bw">
          ${bandwidths.map(([key, label]) => `<option value="${key}" ${selected === key ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <small>FM-DX TEF values. Auto sends W0; selecting “Keep” sends no bandwidth command.</small>
      </label>`;
  }


  function normalizeSignalUnit(unit) {
    const u = String(unit || '').trim().toLowerCase();
    if (u === 'dbuv' || u === 'dbµv' || u === 'dbμv') return 'dbuv';
    if (u === 'dbm') return 'dbm';
    return 'dbf';
  }

  function signalUnitLabel(unit) {
    const u = normalizeSignalUnit(unit);
    if (u === 'dbuv') return 'dBµV';
    if (u === 'dbm') return 'dBm';
    return 'dBf';
  }

  function selectSignalUnit(value) {
    const unit = normalizeSignalUnit(value || 'dbuv');
    return `
      <label class="pwd-field">
        <span>Signal unit for monitoring</span>
        <select id="pwd-signal-unit">
          <option value="dbuv" ${unit === 'dbuv' ? 'selected' : ''}>dBµV</option>
          <option value="dbf" ${unit === 'dbf' ? 'selected' : ''}>dBf raw</option>
          <option value="dbm" ${unit === 'dbm' ? 'selected' : ''}>dBm</option>
        </select>
        <small>dBµV/dBm use the same conversion offsets as TEF firmware and FM-DX Webserver: dBµV = raw dBf - 11.25; dBm = raw dBf - 120.</small>
      </label>`;
  }

  function renderModal() {
    if (!config) return;
    let modal = document.getElementById('pushover-watchdog-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'pushover-watchdog-modal';
      modal.className = 'pwd-modal hidden';
      document.body.appendChild(modal);
    }

    modal.innerHTML = `
      <div class="pwd-card">
        <div class="pwd-header">
          <div>
            <h2>FM Monitor</h2>
            <div class="pwd-subtitle">Pushover Watchdog v${pluginVersion} · ${pluginAuthor} · signal / modulation / RDS / RDS-group / stereo monitoring</div>
          </div>
          <button id="pwd-close" class="pwd-icon-btn" aria-label="Close">×</button>
        </div>

        <div id="pwd-live-status" class="pwd-status"></div>

        <div class="pwd-grid">
          ${checkbox('pwd-enabled', 'Enable monitoring and alerts', config.enabled)}
          ${checkbox('pwd-recovery', 'Send recovery notifications', config.sendRecoveryNotifications)}
          ${checkbox('pwd-rds', 'Include RDS info in notifications', config.includeRdsInfo)}
          ${checkbox('pwd-rtlog-enabled', 'Enable RadioText logging (fully loaded RT only / rolling 7 days)', config.radioTextLoggingEnabled)}
          ${checkbox('pwd-rds-groups-enabled', 'Enable RDS group stream monitoring', config.rdsGroupMonitoringEnabled)}
          ${checkbox('pwd-require-carrier', 'Blank detection requires carrier present', config.requireCarrierForBlank)}
          ${checkbox('pwd-require-carrier-rds', 'RDS missing detection requires carrier present', config.requireCarrierForRds)}
          ${checkbox('pwd-stereo-enabled', 'Enable stereo indicator monitoring', config.stereoMonitorEnabled)}
        </div>

        <h3>Notification channels</h3>
        <div class="pwd-subtitle">Save settings before sending a test notification for a channel.</div>
        <div class="pwd-grid">
          ${checkbox('pwd-pushover-enabled', 'Enable Pushover notifications', config.pushoverEnabled)}
          ${checkbox('pwd-telegram-enabled', 'Enable Telegram notifications', config.telegramEnabled)}
          ${checkbox('pwd-zabbix-enabled', 'Enable Zabbix sender notifications', config.zabbixEnabled)}
        </div>

        <h3>Pushover</h3>
        <div class="pwd-grid">
          ${protectedSecretField('User Key + API Token', config.pushoverCredentialsConfigured, 'pushoverUserKey / pushoverApiToken')}
          ${field('pwd-device', 'Device (optional)', config.pushoverDevice)}
          ${field('pwd-sound', 'Sound', config.pushoverSound)}
          ${field('pwd-priority', 'Priority', config.pushoverPriority, 'number', 'Use 2 only for Emergency alerts; retry and expire are required then.')}
          ${field('pwd-retry', 'Emergency retry seconds', config.pushoverRetrySeconds ?? 60, 'number', 'Only used when Priority is 2. Minimum: 30 seconds; normalized to a maximum of 10800 seconds.')}
          ${field('pwd-expire', 'Emergency expire seconds', config.pushoverExpireSeconds ?? 1800, 'number', 'Only used when Priority is 2. Maximum accepted by Pushover: 10800 seconds (3 hours).')}
        </div>
        <div class="pwd-inline-actions"><button id="pwd-test-pushover" class="pwd-secondary">Test Pushover</button></div>

        <h3>Telegram Bot</h3>
        <div class="pwd-grid">
          ${protectedSecretField('Bot token', config.telegramBotConfigured, 'telegramBotToken')}
          ${field('pwd-telegram-chat', 'Chat ID', config.telegramChatId, 'text', 'User, group or channel chat ID where alerts will be sent.')}
          ${field('pwd-telegram-thread', 'Topic / message thread ID (optional)', config.telegramThreadId, 'text', 'Use only for a Telegram forum topic.')}
        </div>
        <div class="pwd-inline-actions"><button id="pwd-test-telegram" class="pwd-secondary">Test Telegram</button></div>

        <h3>Zabbix sender / trapper</h3>
        <div class="pwd-grid">
          ${field('pwd-zabbix-server', 'Zabbix server or proxy', config.zabbixServer, 'text', 'A reachable Zabbix server/proxy accepting sender data.')}
          ${field('pwd-zabbix-port', 'Port', config.zabbixPort ?? 10051, 'number', 'Default trapper port: 10051.')}
          ${field('pwd-zabbix-host', 'Configured Zabbix host name', config.zabbixHost, 'text', 'Must exactly match the Host name in Zabbix.')}
          ${field('pwd-zabbix-key', 'Trapper item key', config.zabbixKey, 'text', 'Create this key as a Zabbix trapper item; received value is a JSON alert event.')}
        </div>
        <div class="pwd-inline-actions"><button id="pwd-test-zabbix" class="pwd-secondary">Test Zabbix</button></div>

        <h3>Frequencies and timing</h3>
        <label class="pwd-field pwd-wide">
          <span>Frequencies to check</span>
          <textarea id="pwd-frequencies" rows="3">${escapeHtml((Array.isArray(config.frequencies) ? config.frequencies : []).join(', '))}</textarea>
          <small>Use MHz values separated by comma/space, for example: 91.600, 96.200, 101.100</small>
        </label>
        <div class="pwd-grid">
          ${field('pwd-interval', 'Check interval seconds', config.checkIntervalSeconds, 'number')}
          ${field('pwd-settle', 'Tune settle seconds', config.tuneSettleSeconds, 'number')}
          ${field('pwd-dwell', 'Dwell seconds per frequency', config.dwellSeconds, 'number')}
          ${field('pwd-force-retune', 'Force retune grace seconds', config.forceRetuneSeconds, 'number', '0 disables forced return. Otherwise the receiver is tuned back after remaining off target for this duration.')}
          ${field('pwd-cooldown', 'Alert cooldown minutes', config.alertCooldownMinutes, 'number')}
        </div>

        <h3>Receiver options applied after watchdog tune / retune</h3>
        <div class="pwd-grid">
          ${bandwidthSelect(config.forceRetuneBandwidthHz)}
          ${receiverToggleSelect('pwd-force-ceq', 'cEQ after watchdog tune / retune', config.forceRetuneCeq, 'FM-DX sends the combined G command for cEQ and iMS.')}
          ${receiverToggleSelect('pwd-force-ims', 'iMS after watchdog tune / retune', config.forceRetuneIms, 'Keep leaves the current receiver value unchanged.')}
        </div>

        <h3>Thresholds</h3>
        <div class="pwd-grid">
          ${selectSignalUnit(config.signalUnit)}
          ${field('pwd-signal-threshold', `Minimum expected RF signal (${signalUnitLabel(config.signalUnit)})`, config.signalThreshold, 'number', 'Set this relative to the normal signal level of the monitored station. Below this value triggers signal-below-threshold / white-noise detection.')}
          ${field('pwd-no-carrier-seconds', 'Signal-below-threshold duration seconds', config.noCarrierSeconds, 'number')}
          ${field('pwd-rds-missing-seconds', 'RDS missing duration seconds', config.rdsMissingSeconds, 'number', 'Alert when no valid RDS identity (PI or PS) is decoded for this long while monitoring the target frequency.')}
          ${field('pwd-rds-group-missing-seconds', 'RDS group stream loss duration seconds', config.rdsGroupMissingSeconds, 'number', 'Arms only after three usable RDS groups are received at the current target. A usable group has a valid B block, so transient unreadable blocks do not count as normal traffic.')}
          ${field('pwd-rds-group-interruption-events-per-minute', 'RDS group interruption events / minute', config.rdsGroupInterruptionEventsPerMinute ?? 1, 'number', 'Each event is 4 consecutive unreadable RDS groups (----). Alert only when this many distinct events occur inside a rolling 60-second window. Allowed range: 1-600. Default 1 preserves v1.0.4 behaviour.')}
          ${checkbox('pwd-rds-groups-require-carrier', 'RDS group stream monitoring requires carrier present', config.rdsGroupRequireCarrier)}
          ${field('pwd-blank-dbfs', 'Blank audio threshold dBFS', config.audioSilenceThresholdDbfs, 'number', 'Typical start: -45 dBFS. More negative = less sensitive.')}
          ${field('pwd-blank-seconds', 'Blank duration seconds', config.blankSeconds, 'number')}
          ${field('pwd-recovery-seconds', 'Recovery confirmation seconds', config.recoverySeconds, 'number')}
        </div>

        <h3>Stereo indicator instability</h3>
        <div class="pwd-grid">
          ${field('pwd-stereo-window', 'Stereo analysis window seconds', config.stereoWindowSeconds ?? 60, 'number')}
          ${field('pwd-stereo-min-drops', 'Minimum stereo drops in window', config.stereoMinDrops ?? 3, 'number')}
          ${field('pwd-stereo-min-off', 'Minimum off samples in window', config.stereoMinOffSamples ?? 2, 'number')}
          ${field('pwd-stereo-recovery', 'Stereo recovery confirmation seconds', config.stereoRecoverySeconds ?? 30, 'number')}
          ${checkbox('pwd-stereo-require-carrier', 'Stereo monitoring requires carrier/signal above threshold', config.stereoRequireCarrier)}
          ${checkbox('pwd-stereo-require-audio', 'Stereo monitoring requires audio/modulation present', config.stereoRequireAudio)}
          ${checkbox('pwd-stereo-require-rds', 'Stereo monitoring requires valid RDS identity', config.stereoRequireRdsValid)}
        </div>

        <div class="pwd-actions">
          <button id="pwd-open-rtlog" class="pwd-secondary"><i class="fa-solid fa-scroll"></i>&nbsp; RadioText log</button>
          <button id="pwd-save" class="pwd-primary">Save settings</button>
        </div>
      </div>`;

    document.getElementById('pwd-close').onclick = closeModal;
    document.getElementById('pwd-save').onclick = saveFromUi;
    document.getElementById('pwd-open-rtlog').onclick = openRtLogModal;
    ['pushover', 'telegram', 'zabbix'].forEach(channel => {
      const button = document.getElementById(`pwd-test-${channel}`);
      if (button) {
        button.onclick = () => {
          if (!isAdminAuthenticated()) {
            toast('error', 'You must be logged in as an administrator to send test notifications.');
            return;
          }
          send('PushoverWatchdog:testChannel', { channel });
        };
      }
    });
    renderStatus();
  }

  function renderStatus() {
    const el = document.getElementById('pwd-live-status');
    if (!el || !status) return;

    // Build the live status with DOM text nodes instead of innerHTML.
    // Values come from the FM-DX/plugin WebSocket, so this avoids DOM-XSS
    // warnings and remains safe even if a receiver/RDS field contains markup.
    el.textContent = '';

    const appendItem = (label, value) => {
      if (el.childNodes.length) el.appendChild(document.createTextNode(' · '));
      const strong = document.createElement('b');
      strong.textContent = `${label}:`;
      el.appendChild(strong);
      el.appendChild(document.createTextNode(` ${String(value)}`));
    };

    const targetFrequency = `${safeText(status.activeFrequency || '-', 40)} MHz`;
    const currentFrequency = `${safeText(status.currentFrequency || '-', 40)} MHz`;
    let signalText = '-';
    if (Number.isFinite(status.signal)) {
      signalText = `${status.signal.toFixed(1)} ${safeText(status.signalUnitLabel || '', 16)}`;
      if (Number.isFinite(status.signalRawDbf) && status.signalUnit !== 'dbf') {
        signalText += ` (raw ${status.signalRawDbf.toFixed(1)} dBf)`;
      }
    }
    const audioText = status.audioDbfs === null || typeof status.audioDbfs === 'undefined'
      ? 'n/a'
      : `${safeText(status.audioDbfs, 32)} dBFS`;
    const rtLogText = status.radioTextLoggingEnabled
      ? `${safeText(status.radioTextLogCount || 0, 20)} entries / 7 days`
      : 'disabled';
    let rdsGroupsText = 'disabled';
    if (status.rdsGroupMonitoringEnabled) {
      if (!status.rdsGroupSocketConnected) rdsGroupsText = 'local /rds unavailable';
      else if (!status.rdsGroupArmed) rdsGroupsText = 'waiting for baseline';
      else {
        const age = Number.isFinite(status.rdsGroupLastSeenAgeSeconds)
          ? `${status.rdsGroupLastSeenAgeSeconds.toFixed(1)}s ago`
          : 'age unknown';
        rdsGroupsText = `${safeText(status.rdsGroupLastType || '?', 4)} · ${age}`;
      }
    }

    appendItem('Status', status.enabled ? 'enabled' : 'disabled');
    appendItem('Target', targetFrequency);
    appendItem('Current', currentFrequency);
    appendItem('Signal', signalText);
    appendItem('RDS valid', status.rdsValid ? 'yes' : 'no');
    appendItem('RDS groups', rdsGroupsText);
    appendItem('Stereo', status.stereo ? 'yes' : 'no');
    appendItem('Audio', audioText);
    appendItem('RT log', rtLogText);
  }

  function readNum(id, fallback) {
    const n = Number(document.getElementById(id).value);
    return Number.isFinite(n) ? n : fallback;
  }

  function saveFromUi() {
    if (!isAdminAuthenticated()) {
      toast('error', 'You must be logged in as an administrator to edit FM Monitor settings.');
      return;
    }
    const frequencies = document.getElementById('pwd-frequencies').value
      .split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);

    const next = {
      enabled: document.getElementById('pwd-enabled').checked,
      pushoverEnabled: document.getElementById('pwd-pushover-enabled').checked,
      pushoverDevice: document.getElementById('pwd-device').value.trim(),
      pushoverSound: document.getElementById('pwd-sound').value.trim(),
      pushoverPriority: readNum('pwd-priority', 0),
      pushoverRetrySeconds: readNum('pwd-retry', 60),
      pushoverExpireSeconds: readNum('pwd-expire', 1800),
      telegramEnabled: document.getElementById('pwd-telegram-enabled').checked,
      telegramChatId: document.getElementById('pwd-telegram-chat').value.trim(),
      telegramThreadId: document.getElementById('pwd-telegram-thread').value.trim(),
      zabbixEnabled: document.getElementById('pwd-zabbix-enabled').checked,
      zabbixServer: document.getElementById('pwd-zabbix-server').value.trim(),
      zabbixPort: readNum('pwd-zabbix-port', 10051),
      zabbixHost: document.getElementById('pwd-zabbix-host').value.trim(),
      zabbixKey: document.getElementById('pwd-zabbix-key').value.trim(),
      radioTextLoggingEnabled: document.getElementById('pwd-rtlog-enabled').checked,
      rdsGroupMonitoringEnabled: document.getElementById('pwd-rds-groups-enabled').checked,
      rdsGroupMissingSeconds: readNum('pwd-rds-group-missing-seconds', 10),
      rdsGroupInterruptionEventsPerMinute: readNum('pwd-rds-group-interruption-events-per-minute', 1),
      rdsGroupRequireCarrier: document.getElementById('pwd-rds-groups-require-carrier').checked,
      frequencies,
      checkIntervalSeconds: readNum('pwd-interval', 2),
      tuneSettleSeconds: readNum('pwd-settle', 4),
      dwellSeconds: readNum('pwd-dwell', 30),
      forceRetuneSeconds: readNum('pwd-force-retune', 10),
      forceRetuneBandwidthHz: document.getElementById('pwd-force-bw').value,
      forceRetuneCeq: document.getElementById('pwd-force-ceq').value,
      forceRetuneIms: document.getElementById('pwd-force-ims').value,
      signalUnit: normalizeSignalUnit(document.getElementById('pwd-signal-unit').value),
      signalThreshold: readNum('pwd-signal-threshold', 20),
      noCarrierSeconds: readNum('pwd-no-carrier-seconds', 20),
      rdsMissingSeconds: readNum('pwd-rds-missing-seconds', 30),
      requireCarrierForRds: document.getElementById('pwd-require-carrier-rds').checked,
      blankSeconds: readNum('pwd-blank-seconds', 30),
      audioSilenceThresholdDbfs: readNum('pwd-blank-dbfs', -45),
      requireCarrierForBlank: document.getElementById('pwd-require-carrier').checked,
      stereoMonitorEnabled: document.getElementById('pwd-stereo-enabled').checked,
      stereoWindowSeconds: readNum('pwd-stereo-window', 60),
      stereoMinDrops: readNum('pwd-stereo-min-drops', 3),
      stereoMinOffSamples: readNum('pwd-stereo-min-off', 2),
      stereoRequireCarrier: document.getElementById('pwd-stereo-require-carrier').checked,
      stereoRequireAudio: document.getElementById('pwd-stereo-require-audio').checked,
      stereoRequireRdsValid: document.getElementById('pwd-stereo-require-rds').checked,
      stereoRecoverySeconds: readNum('pwd-stereo-recovery', 30),
      recoverySeconds: readNum('pwd-recovery-seconds', 10),
      alertCooldownMinutes: readNum('pwd-cooldown', 10),
      sendRecoveryNotifications: document.getElementById('pwd-recovery').checked,
      includeRdsInfo: document.getElementById('pwd-rds').checked
    };
    send('PushoverWatchdog:saveConfig', next);
  }

  function ensureRtLogModal() {
    let modal = document.getElementById('pushover-watchdog-rtlog-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'pushover-watchdog-rtlog-modal';
      modal.className = 'pwd-modal hidden';
      modal.innerHTML = `
        <div class="pwd-card pwd-rtlog-card">
          <div class="pwd-header">
            <div>
              <h2><i class="fa-solid fa-scroll"></i>&nbsp; RadioText log</h2>
              <div class="pwd-subtitle">Rolling retention: the most recent 7 days only. Each settled RadioText A/B sequence is stored only when its text changes.</div>
            </div>
            <button id="pwd-rtlog-close" class="pwd-icon-btn" aria-label="Close">×</button>
          </div>
          <div class="pwd-inline-actions pwd-rtlog-actions">
            <button id="pwd-rtlog-refresh" class="pwd-secondary">Refresh</button>
            <button id="pwd-rtlog-older" class="pwd-secondary">Load older</button>
          </div>
          <div class="pwd-rtlog-table-wrap">
            <table class="pwd-rtlog-table">
              <thead><tr><th>Date / time</th><th>Frequency</th><th>PI</th><th>PS</th><th>RadioText</th></tr></thead>
              <tbody id="pwd-rtlog-body"></tbody>
            </table>
          </div>
          <div id="pwd-rtlog-summary" class="pwd-subtitle"></div>
        </div>`;
      document.body.appendChild(modal);
      document.getElementById('pwd-rtlog-close').onclick = closeRtLogModal;
      document.getElementById('pwd-rtlog-refresh').onclick = () => requestRtLog(true);
      document.getElementById('pwd-rtlog-older').onclick = () => requestRtLog(false);
    }
    renderRtLogRows();
    return modal;
  }

  function renderRtLogRows() {
    const body = document.getElementById('pwd-rtlog-body');
    const summary = document.getElementById('pwd-rtlog-summary');
    const olderButton = document.getElementById('pwd-rtlog-older');

    if (olderButton) olderButton.disabled = !rtLogHasMore;
    if (summary) {
      summary.textContent = rtLogEntries.length
        ? `${rtLogEntries.length} displayed entr${rtLogEntries.length === 1 ? 'y' : 'ies'}.`
        : 'No RadioText has been recorded in the retained interval.';
    }
    if (!body) return;

    body.textContent = '';
    if (!rtLogEntries.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'pwd-empty';
      td.textContent = 'No RadioText log entries.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of rtLogEntries) {
      if (!isPlainObject(entry)) continue;
      const tr = document.createElement('tr');
      const values = [
        entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '-',
        `${safeText(entry.frequency || '-', 40)} MHz`,
        safeText(entry.pi || '-', 16),
        safeText(entry.ps || '-', 16),
        safeText(entry.rt || '-', 256)
      ];
      values.forEach((value, index) => {
        const td = document.createElement('td');
        if (index === 4) td.className = 'pwd-rt-text';
        td.textContent = value;
        tr.appendChild(td);
      });
      fragment.appendChild(tr);
    }
    body.appendChild(fragment);
  }

  function requestRtLog(reset) {
    if (!isAdminAuthenticated()) return;
    if (reset) {
      rtLogEntries = [];
      rtLogBefore = null;
    }
    rtLogAppendNext = !reset;
    send('PushoverWatchdog:getRtLog', {
      before: reset ? null : rtLogBefore,
      limit: 100
    });
  }

  function applyRtLogPage(page) {
    const entries = Array.isArray(page.entries)
      ? page.entries.slice(0, maxRtLogPageSize).filter(isPlainObject)
      : [];
    rtLogEntries = rtLogAppendNext ? rtLogEntries.concat(entries) : entries;
    rtLogAppendNext = false;
    rtLogHasMore = !!page.hasMore;
    rtLogBefore = typeof page.nextBefore === 'string' ? safeText(page.nextBefore, 64) : null;
    const modal = ensureRtLogModal();
    if (!modal.classList.contains('hidden')) modal.classList.remove('hidden');
  }

  function openRtLogModal() {
    if (!isAdminAuthenticated()) {
      toast('error', 'You must be logged in as an administrator to view the RadioText log.');
      return;
    }
    const modal = ensureRtLogModal();
    modal.classList.remove('hidden');
    requestRtLog(true);
  }

  function closeRtLogModal() {
    const modal = document.getElementById('pushover-watchdog-rtlog-modal');
    if (modal) modal.classList.add('hidden');
  }

  function openModal() {
    if (!isAdminAuthenticated()) {
      toast('error', 'You must be logged in as an administrator to open FM Monitor settings.');
      return;
    }
    send('PushoverWatchdog:getConfig', {});
    const modal = document.getElementById('pushover-watchdog-modal');
    if (modal) modal.classList.remove('hidden');
  }

  function closeModal() {
    const modal = document.getElementById('pushover-watchdog-modal');
    if (modal) modal.classList.add('hidden');
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function injectCss() {
    if (document.getElementById('pushover-watchdog-css')) return;
    const style = document.createElement('style');
    style.id = 'pushover-watchdog-css';
    style.textContent = `
      .pwd-modal{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:18px;}
      .pwd-modal.hidden{display:none;}
      .pwd-card{width:min(920px,96vw);max-height:92vh;overflow:auto;background:var(--color-1,#161616);color:var(--color-main-bright,#fff);border:1px solid var(--color-2,#333);border-radius:14px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.45);}
      .pwd-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:12px;}
      .pwd-header h2{margin:0;font-size:22px;}
      .pwd-subtitle{opacity:.75;font-size:13px;margin-top:3px;}
      .pwd-icon-btn{background:transparent;color:inherit;border:0;font-size:30px;cursor:pointer;line-height:1;}
      .pwd-status{background:var(--color-2-transparent,rgba(255,255,255,.08));border-radius:10px;padding:10px;margin:10px 0 16px;font-size:13px;line-height:1.5;}
      .pwd-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:12px;}
      .pwd-field{display:flex;flex-direction:column;gap:5px;font-size:13px;}
      .pwd-field input,.pwd-field textarea,.pwd-field select{width:100%;box-sizing:border-box;border:1px solid var(--color-2,#444);background:var(--color-0,#0f0f0f);color:var(--color-main-bright,#fff);border-radius:8px;padding:8px;font:inherit;}
      .pwd-secret-status{border:1px solid var(--color-2,#444);background:var(--color-0,#0f0f0f);border-radius:8px;padding:8px;font:inherit;opacity:.9;}
      .pwd-field code{font-size:12px;}
      .pwd-field small{opacity:.65;line-height:1.35;}
      .pwd-wide{margin-bottom:12px;}
      .pwd-check{display:flex;align-items:center;gap:8px;background:var(--color-2-transparent,rgba(255,255,255,.06));border-radius:8px;padding:8px;font-size:13px;}
      .pwd-card h3{margin:18px 0 10px;font-size:15px;color:var(--color-4,#7ab7ff);}
      .pwd-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px;}
      .pwd-inline-actions{display:flex;justify-content:flex-end;gap:10px;margin:4px 0 14px;}
      .pwd-primary,.pwd-secondary{border:0;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:600;}
      .pwd-primary{background:var(--color-4,#7ab7ff);color:#000;}
      .pwd-secondary{background:var(--color-2,#333);color:var(--color-main-bright,#fff);}
      .pwd-secondary:disabled{opacity:.5;cursor:not-allowed;}
      .pwd-rtlog-card{width:min(1120px,96vw);}
      .pwd-rtlog-actions{justify-content:flex-start;}
      .pwd-rtlog-table-wrap{overflow:auto;max-height:65vh;border:1px solid var(--color-2,#333);border-radius:10px;margin-bottom:10px;}
      .pwd-rtlog-table{width:100%;border-collapse:collapse;font-size:13px;}
      .pwd-rtlog-table th,.pwd-rtlog-table td{padding:9px;border-bottom:1px solid var(--color-2,#333);text-align:left;vertical-align:top;}
      .pwd-rtlog-table th{position:sticky;top:0;background:var(--color-1,#161616);color:var(--color-4,#7ab7ff);}
      .pwd-rt-text{min-width:300px;white-space:pre-wrap;word-break:break-word;}
      .pwd-empty{text-align:center!important;opacity:.7;padding:28px!important;}
      @media(max-width:720px){.pwd-grid{grid-template-columns:1fr}.pwd-actions{flex-direction:column}.pwd-primary,.pwd-secondary{width:100%;}.pwd-rt-text{min-width:220px;}}
    `;
    document.head.appendChild(style);
  }

  function removeButtons() {
    ['pushover-watchdog-button', 'pushover-watchdog-rtlog-button'].forEach(id => {
      const existing = document.getElementById(id);
      if (existing) existing.remove();
    });
  }

  function removePluginUi() {
    ['pushover-watchdog-button', 'pushover-watchdog-rtlog-button', 'pushover-watchdog-modal', 'pushover-watchdog-rtlog-modal', 'pushover-watchdog-css'].forEach(id => {
      const node = document.getElementById(id);
      if (node) node.remove();
    });
  }

  function addPanelButton(id, label, icon, tooltip, onClick) {
    const attachClick = () => {
      const btn = document.getElementById(id);
      if (btn && !btn.__pwdClickAttached) {
        btn.__pwdClickAttached = true;
        btn.addEventListener('click', onClick);
      }
    };

    if (document.getElementById(id)) {
      attachClick();
      return;
    }
    if (typeof addIconToPluginPanel === 'function') {
      addIconToPluginPanel(id, label, 'solid', icon, tooltip);
      attachClick();
      return;
    }

    const container = document.querySelector('.scrollable-container');
    if (!container) return;
    const btn = document.createElement('button');
    btn.className = 'no-bg color-4 hover-brighten tooltip';
    btn.id = id;
    btn.style.cssText = 'padding: 6px; width: 64px; min-width: 64px;';
    btn.setAttribute('data-tooltip', safeText(tooltip, 80));
    btn.setAttribute('data-tooltip-placement', 'bottom');

    const iconEl = document.createElement('i');
    const safeIcon = String(icon || '').replace(/[^a-z0-9-]/gi, '');
    iconEl.className = `fa-solid fa-${safeIcon} fa-lg top-10`;
    btn.appendChild(iconEl);
    btn.appendChild(document.createElement('br'));

    const labelEl = document.createElement('span');
    labelEl.style.cssText = 'font-size: 10px; color: var(--color-main-bright) !important;';
    labelEl.textContent = safeText(label, 40);
    btn.appendChild(labelEl);

    container.appendChild(btn);
    if (typeof initTooltips === 'function') initTooltips($(btn));
    if (typeof checkScroll === 'function') runtimeSetTimeout(checkScroll, 100);
    attachClick();
  }

  function addButton() {
    if (!isAdminAuthenticated()) {
      removeButtons();
      return;
    }
    addPanelButton('pushover-watchdog-button', 'FM Monitor', 'bell', 'FM Monitor', openModal);
    addPanelButton('pushover-watchdog-rtlog-button', 'RT Log', 'scroll', 'RadioText log', openRtLogModal);
  }

  let started = false;

  function deactivateAdminUi() {
    removePluginUi();
    runtimeClearTimer(wsReconnectTimer);
    wsReconnectTimer = null;
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    config = null;
    status = null;
    channelToken = null;
    rtLogEntries = [];
    rtLogHasMore = false;
    rtLogBefore = null;
    rtLogAppendNext = false;
    started = false;
  }

  function startWhenAuthenticated() {
    if (!isAdminAuthenticated()) {
      deactivateAdminUi();
      return;
    }

    if (!started) {
      started = true;
      injectCss();
      renderModal();
      connect();
    }

    addButton();
  }

  function boot() {
    if (runtime.stopped) return;
    startWhenAuthenticated();

    // Some FM-DX elements are injected after plugin scripts run. Keep checking
    // briefly and also react to DOM changes, so the button appears as soon as
    // the logged-in dashboard is present.
    const interval = runtimeSetInterval(startWhenAuthenticated, 1000);
    runtimeSetTimeout(() => runtimeClearTimer(interval), 30000);

    // Keep a low-frequency session guard for the lifetime of the page. FM-DX's
    // shared plugin WebSocket can otherwise stay open after the initial 30-second
    // boot window if an administrator logs out without reloading the page.
    runtimeSetInterval(startWhenAuthenticated, adminSessionCheckMs);

    if (document.body && typeof MutationObserver !== 'undefined') {
      let observerRefreshTimer = null;
      const observer = new MutationObserver(() => {
        // DOM-heavy FM-DX views can emit many mutation records in one burst.
        // Coalesce them into one auth/UI refresh while keeping the existing
        // one-second polling fallback and 30-second observation window.
        if (observerRefreshTimer) return;
        observerRefreshTimer = runtimeSetTimeout(() => {
          observerRefreshTimer = null;
          startWhenAuthenticated();
        }, 100);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      runtime.observers.add(observer);
      runtimeSetTimeout(() => {
        runtimeClearTimer(observerRefreshTimer);
        observerRefreshTimer = null;
        try { observer.disconnect(); } catch (_) {}
        runtime.observers.delete(observer);
      }, 30000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
