'use strict';

(() => {
  const runtimeKey = '__PushoverWatchdogFrontendRuntime';
  if (window[runtimeKey] && typeof window[runtimeKey].stop === 'function') {
    try { window[runtimeKey].stop(); } catch (_) {}
  }
  const runtime = {
    timers: new Set(),
    observers: new Set(),
    stop() {
      for (const timer of this.timers) {
        try { clearTimeout(timer); clearInterval(timer); } catch (_) {}
      }
      this.timers.clear();
      for (const observer of this.observers) {
        try { observer.disconnect(); } catch (_) {}
      }
      this.observers.clear();
      try { if (ws) ws.close(); } catch (_) {}
      ws = null;
    }
  };
  window[runtimeKey] = runtime;

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

  const pluginName = 'Pushover Watchdog';
  const pluginVersion = '1.0.0';
  const pluginAuthor = 'by Play Radio Constanta';
  let config = null;
  let status = null;
  let ws = null;
  let wsReconnectTimer = null;

  function wsUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${window.location.pathname}data_plugins`;
  }

  function isAuthenticated() {
    const bodyText = document.body ? (document.body.textContent || document.body.innerText || '') : '';

    // FM-DX Webserver v1.4.x exposes the login state in the side panel text,
    // but depending on theme/plugin load order that text may not be available
    // at the exact moment this plugin starts. The dashboard/logout elements are
    // reliable additional indicators that a user is logged in.
    return bodyText.includes('You are logged in as an administrator.') ||
      bodyText.includes('You are logged in as an adminstrator.') ||
      bodyText.includes('You are logged in and can control the receiver.') ||
      !!document.querySelector('.logout-link, #dashboard-lock-admin, #dashboard-lock-tune');
  }

  function connect() {
    if (!isAuthenticated()) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (wsReconnectTimer) {
      runtimeClearTimer(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
      send('PushoverWatchdog:getConfig', {});
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'PushoverWatchdog:config') {
        config = msg.value;
        renderModal();
      }
      if (msg.type === 'PushoverWatchdog:status') {
        status = msg.value;
        renderStatus();
      }
      if (msg.type === 'PushoverWatchdog:toast') {
        toast(msg.value?.level || 'info', msg.value?.message || 'Pushover Watchdog update');
      }
    });
    ws.addEventListener('close', () => {
      ws = null;
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
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
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

  function field(id, label, value, type = 'text', help = '') {
    return `
      <label class="pwd-field">
        <span>${label}</span>
        <input id="${id}" type="${type}" value="${escapeHtml(value ?? '')}">
        ${help ? `<small>${help}</small>` : ''}
      </label>`;
  }

  function checkbox(id, label, value) {
    return `
      <label class="pwd-check">
        <input id="${id}" type="checkbox" ${value ? 'checked' : ''}>
        <span>${label}</span>
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
        <small>dBµV uses the same conversion as MetricsMonitor: dBµV = raw dBf - 10.875.</small>
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
            <h2>${pluginName}</h2>
            <div class="pwd-subtitle">v${pluginVersion} · ${pluginAuthor} · blank / dBµV signal threshold / RDS / stereo indicator alerts via Pushover</div>
          </div>
          <button id="pwd-close" class="pwd-icon-btn">×</button>
        </div>

        <div id="pwd-live-status" class="pwd-status"></div>

        <div class="pwd-grid">
          ${checkbox('pwd-enabled', 'Enable watchdog', config.enabled)}
          ${checkbox('pwd-recovery', 'Send recovery notifications', config.sendRecoveryNotifications)}
          ${checkbox('pwd-rds', 'Include RDS info in notifications', config.includeRdsInfo)}
          ${checkbox('pwd-require-carrier', 'Blank detection requires carrier present', config.requireCarrierForBlank)}
          ${checkbox('pwd-require-carrier-rds', 'RDS missing detection requires carrier present', config.requireCarrierForRds)}
          ${checkbox('pwd-stereo-enabled', 'Enable stereo indicator monitoring', config.stereoMonitorEnabled)}
        </div>

        <h3>Pushover</h3>
        <div class="pwd-grid">
          ${field('pwd-user', 'User Key', config.pushoverUserKey)}
          ${field('pwd-token', 'API Token', config.pushoverApiToken)}
          ${field('pwd-device', 'Device (optional)', config.pushoverDevice)}
          ${field('pwd-sound', 'Sound', config.pushoverSound)}
          ${field('pwd-priority', 'Priority', config.pushoverPriority, 'number', 'Use 2 only for Emergency alerts; retry and expire are required then.')}
          ${field('pwd-retry', 'Emergency retry seconds', config.pushoverRetrySeconds ?? 60, 'number', 'Only used when Priority is 2. Minimum accepted by Pushover: 30 seconds.')}
          ${field('pwd-expire', 'Emergency expire seconds', config.pushoverExpireSeconds ?? 1800, 'number', 'Only used when Priority is 2. Example: 1800 = repeat for 30 minutes.')}
        </div>

        <h3>Frequencies and timing</h3>
        <label class="pwd-field pwd-wide">
          <span>Frequencies to check</span>
          <textarea id="pwd-frequencies" rows="3">${escapeHtml((config.frequencies || []).join(', '))}</textarea>
          <small>Use MHz values separated by comma/space, for example: 91.600, 96.200, 101.100</small>
        </label>
        <div class="pwd-grid">
          ${field('pwd-interval', 'Check interval seconds', config.checkIntervalSeconds, 'number')}
          ${field('pwd-settle', 'Tune settle seconds', config.tuneSettleSeconds, 'number')}
          ${field('pwd-dwell', 'Dwell seconds per frequency', config.dwellSeconds, 'number')}
          ${field('pwd-force-retune', 'Force retune interval seconds', config.forceRetuneSeconds, 'number', '0 disables it. If the receiver is left on another frequency, the plugin tunes back to the active monitored frequency after this interval.')}
          ${field('pwd-cooldown', 'Alert cooldown minutes', config.alertCooldownMinutes, 'number')}
        </div>

        <h3>Thresholds</h3>
        <div class="pwd-grid">
          ${selectSignalUnit(config.signalUnit)}
          ${field('pwd-signal-threshold', `Minimum expected RF signal (${signalUnitLabel(config.signalUnit)})`, config.signalThreshold, 'number', 'Set this relative to the normal signal level of the monitored station. Below this value triggers signal-below-threshold / white-noise detection. For dBµV, the plugin converts FM-DX raw dBf to dBµV using the same offset as MetricsMonitor.')}
          ${field('pwd-no-carrier-seconds', 'Signal-below-threshold duration seconds', config.noCarrierSeconds, 'number')}
          ${field('pwd-rds-missing-seconds', 'RDS missing duration seconds', config.rdsMissingSeconds, 'number', 'Alert when no valid RDS identity (PI or PS) is decoded for this long while monitoring the target frequency. Raw RDS lock is shown only as diagnostic information.')}
          ${field('pwd-blank-dbfs', 'Blank audio threshold dBFS', config.audioSilenceThresholdDbfs, 'number', 'Typical start: -45 dBFS. More negative = less sensitive.')}
          ${field('pwd-blank-seconds', 'Blank duration seconds', config.blankSeconds, 'number')}
          ${field('pwd-recovery-seconds', 'Recovery confirmation seconds', config.recoverySeconds, 'number')}
        </div>

        <h3>Stereo indicator instability</h3>
        <div class="pwd-grid">
          ${field('pwd-stereo-window', 'Stereo analysis window seconds', config.stereoWindowSeconds ?? 60, 'number', 'Uses the normal check interval. Example: at 2 seconds, a 60-second window keeps about 30 samples.')}
          ${field('pwd-stereo-min-drops', 'Minimum stereo drops in window', config.stereoMinDrops ?? 3, 'number', 'Counts yes → no transitions of the webserver stereo indicator.')}
          ${field('pwd-stereo-min-off', 'Minimum off samples in window', config.stereoMinOffSamples ?? 2, 'number', 'Also alerts if the stereo indicator is caught as off this many times inside the window.')}
          ${field('pwd-stereo-recovery', 'Stereo recovery confirmation seconds', config.stereoRecoverySeconds ?? 30, 'number', 'How long stereo must remain stable/on before a recovery notification is sent.')}
          ${checkbox('pwd-stereo-require-carrier', 'Stereo monitoring requires carrier/signal above threshold', config.stereoRequireCarrier)}
          ${checkbox('pwd-stereo-require-audio', 'Stereo monitoring requires audio/modulation present', config.stereoRequireAudio)}
          ${checkbox('pwd-stereo-require-rds', 'Stereo monitoring requires valid RDS identity', config.stereoRequireRdsValid)}
        </div>

        <div class="pwd-actions">
          <button id="pwd-test" class="pwd-secondary">Send test</button>
          <button id="pwd-save" class="pwd-primary">Save settings</button>
        </div>
      </div>`;

    document.getElementById('pwd-close').onclick = closeModal;
    document.getElementById('pwd-save').onclick = saveFromUi;
    document.getElementById('pwd-test').onclick = () => {
      if (!isAuthenticated()) {
        toast('error', 'You must be logged in to send test notifications.');
        return;
      }
      send('PushoverWatchdog:test', {});
    };
    renderStatus();
  }

  function renderStatus() {
    const el = document.getElementById('pwd-live-status');
    if (!el || !status) return;
    el.innerHTML = `
      <b>Status:</b> ${status.enabled ? 'enabled' : 'disabled'} ·
      <b>Target:</b> ${escapeHtml(status.activeFrequency || '-')} MHz ·
      <b>Current:</b> ${escapeHtml(status.currentFrequency || '-')} MHz ·
      <b>Signal:</b> ${Number.isFinite(status.signal) ? status.signal.toFixed(1) + ' ' + escapeHtml(status.signalUnitLabel || '') : '-'}${Number.isFinite(status.signalRawDbf) && status.signalUnit !== 'dbf' ? ' (raw ' + status.signalRawDbf.toFixed(1) + ' dBf)' : ''} ·
      <b>RDS lock:</b> ${status.rdsPresent ? 'yes' : '?'} ·
      <b>RDS valid:</b> ${status.rdsValid ? 'yes' : 'no'} ·
      <b>Stereo:</b> ${status.stereo ? 'yes' : 'no'} ·
      <b>Audio:</b> ${status.audioDbfs === null ? 'n/a' : status.audioDbfs + ' dBFS'} ·
      <b>Audio monitor:</b> ${status.audioAttached ? 'attached' : 'not attached'}`;
  }

  function readNum(id, fallback) {
    const n = Number(document.getElementById(id).value);
    return Number.isFinite(n) ? n : fallback;
  }

  function saveFromUi() {
    if (!isAuthenticated()) {
      toast('error', 'You must be logged in to edit FM Monitor settings.');
      return;
    }
    const frequencies = document.getElementById('pwd-frequencies').value
      .split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);

    const next = {
      enabled: document.getElementById('pwd-enabled').checked,
      pushoverUserKey: document.getElementById('pwd-user').value.trim(),
      pushoverApiToken: document.getElementById('pwd-token').value.trim(),
      pushoverDevice: document.getElementById('pwd-device').value.trim(),
      pushoverSound: document.getElementById('pwd-sound').value.trim(),
      pushoverPriority: readNum('pwd-priority', 0),
      pushoverRetrySeconds: readNum('pwd-retry', 60),
      pushoverExpireSeconds: readNum('pwd-expire', 1800),
      frequencies,
      checkIntervalSeconds: readNum('pwd-interval', 2),
      tuneSettleSeconds: readNum('pwd-settle', 4),
      dwellSeconds: readNum('pwd-dwell', 30),
      forceRetuneSeconds: readNum('pwd-force-retune', 10),
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
      includeRdsInfo: document.getElementById('pwd-rds').checked,
      debugLogging: false
    };
    send('PushoverWatchdog:saveConfig', next);
  }

  function openModal() {
    if (!isAuthenticated()) {
      toast('error', 'You must be logged in to open FM Monitor settings.');
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
      .pwd-field small{opacity:.65;line-height:1.35;}
      .pwd-wide{margin-bottom:12px;}
      .pwd-check{display:flex;align-items:center;gap:8px;background:var(--color-2-transparent,rgba(255,255,255,.06));border-radius:8px;padding:8px;font-size:13px;}
      .pwd-card h3{margin:18px 0 10px;font-size:15px;color:var(--color-4,#7ab7ff);}
      .pwd-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px;}
      .pwd-primary,.pwd-secondary{border:0;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:600;}
      .pwd-primary{background:var(--color-4,#7ab7ff);color:#000;}
      .pwd-secondary{background:var(--color-2,#333);color:var(--color-main-bright,#fff);}
      @media(max-width:720px){.pwd-grid{grid-template-columns:1fr}.pwd-actions{flex-direction:column}.pwd-primary,.pwd-secondary{width:100%;}}
    `;
    document.head.appendChild(style);
  }

  function addButton() {
    if (!isAuthenticated()) {
      const existing = document.getElementById('pushover-watchdog-button');
      if (existing) existing.remove();
      return;
    }

    const attachClick = () => {
      const btn = document.getElementById('pushover-watchdog-button');
      if (btn && !btn.__pushoverWatchdogClickAttached) {
        btn.__pushoverWatchdogClickAttached = true;
        btn.addEventListener('click', openModal);
      }
    };

    const fallbackButtonCreate = () => {
      if (document.getElementById('pushover-watchdog-button')) { attachClick(); return; }
      const container = document.querySelector('.scrollable-container');
      if (!container) return;
      const btn = document.createElement('button');
      btn.className = 'no-bg color-4 hover-brighten tooltip';
      btn.id = 'pushover-watchdog-button';
      btn.style.cssText = 'padding: 6px; width: 64px; min-width: 64px;';
      btn.setAttribute('data-tooltip', 'FM Monitor');
      btn.setAttribute('data-tooltip-placement', 'bottom');
      btn.innerHTML = '<i class="fa-solid fa-bell fa-lg top-10"></i><br><span style="font-size: 10px; color: var(--color-main-bright) !important;">FM Monitor</span>';
      container.appendChild(btn);
      if (typeof initTooltips === 'function') initTooltips($(btn));
      if (typeof checkScroll === 'function') runtimeSetTimeout(checkScroll, 100);
      attachClick();
    };

    const doAdd = () => {
      if (document.getElementById('pushover-watchdog-button')) { attachClick(); return; }
      if (typeof addIconToPluginPanel === 'function') {
        addIconToPluginPanel('pushover-watchdog-button', 'FM Monitor', 'solid', 'bell', 'FM Monitor');
        attachClick();
      } else {
        fallbackButtonCreate();
      }
    };

    doAdd();
  }

  let started = false;

  function startWhenAuthenticated() {
    if (!isAuthenticated()) {
      const existing = document.getElementById('pushover-watchdog-button');
      if (existing) existing.remove();
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
    startWhenAuthenticated();

    // Some FM-DX elements are injected after plugin scripts run. Keep checking
    // briefly and also react to DOM changes, so the button appears as soon as
    // the logged-in dashboard is present.
    const interval = runtimeSetInterval(startWhenAuthenticated, 1000);
    runtimeSetTimeout(() => runtimeClearTimer(interval), 30000);

    if (document.body && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(startWhenAuthenticated);
      observer.observe(document.body, { childList: true, subtree: true });
      runtime.observers.add(observer);
      runtimeSetTimeout(() => {
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
