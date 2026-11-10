'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const backend = path.resolve(__dirname, '../plugin/PushoverWatchdog/pushover-watchdog_server.js');
const source = fs.readFileSync(process.env.WATCHDOG_BACKEND || backend, 'utf8');
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const frame = type => Buffer.from(JSON.stringify({ type: `PushoverWatchdog:${type}` }));

function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
  if (options.config) {
    fs.mkdirSync(path.join(dir, 'plugins_configs'));
    fs.writeFileSync(path.join(dir, 'plugins_configs/PushoverWatchdog.json'), JSON.stringify(options.config));
  }
  const wss = new EventEmitter();
  wss.clients = new Set();
  const warnings = [];
  const timers = new Set();
  let now = 10000;
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    bufferedAmount = 0;
    sent = [];
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const timer = (fn, delay) => { const handle = { fn, delay, unref() {} }; timers.add(handle); return handle; };
  const sandbox = {
    Buffer, URL, URLSearchParams, console, process: { pid: process.pid },
    Date: class extends Date { static now() { return now; } },
    __dirname: path.join(dir, 'plugin/PushoverWatchdog'),
    setTimeout: timer, setInterval: timer,
    clearTimeout: handle => timers.delete(handle), clearInterval: handle => timers.delete(handle),
    require(name) {
      if (options.modules?.[name]) return options.modules[name];
      if (name === 'ws') return Socket;
      if (name === 'fs') return { ...fs, watch: () => ({ close() {} }) };
      if (name === '../../server/console') return { logInfo() {}, logWarn: x => warnings.push(x), logError: x => warnings.push(x) };
      if (name === '../../server/server_config') return { serverConfig: { webserver: { webserverPort: 8080 } } };
      if (name === '../../server/datahandler') return { dataToSend: {} };
      if (name === '../../server/plugins_api') return { getPluginsWss: () => wss, sendPrivilegedCommand: async () => {} };
      if (name === '../../server/stream/3las.server') return {};
      if (name === './rds-group-monitor') return require('../plugin/PushoverWatchdog/rds-group-monitor');
      return require(name);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\n globalThis.testApi = { runtime, sendTestNotification, dispatchNotifications, sendPluginMessageTo, sendPluginMessage, pluginClientMessageHandlers, stats: () => ({ active: pluginActiveActions, pending: pluginPendingActions }) };', sandbox, { filename: backend });
  t.after(() => { sandbox.testApi.runtime.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  function connect(session = {}, headers = {}) {
    const client = new Socket();
    wss.clients.add(client);
    client.once('close', () => wss.clients.delete(client));
    const request = { session, headers };
    wss.emit('connection', client, request);
    return { client, request };
  }
  return { ...sandbox.testApi, connect, warnings, timers, wss, sandbox, dir, advance: ms => { now += ms; } };
}

test('stalled session flood retains bounded actions and emits bounded rejections', async t => {
  const h = harness(t);
  let reloads = 0;
  let complete;
  const { client } = h.connect({ reload(cb) { reloads++; complete = cb; } });
  for (let i = 0; i < 2000; i++) client.emit('message', frame('getConfig'));
  assert.equal(reloads, 1);
  complete();
  await flush();
  assert.ok(client.sent.length <= 1, `emitted ${client.sent.length} rejection frames`);
  assert.ok(h.warnings.length <= 1, `emitted ${h.warnings.length} warning entries`);
  assert.ok(client.readyState !== 1, 'overflow client must be disconnected');
});

test('slow consumer is terminated before another response is buffered', t => {
  const h = harness(t);
  const { client } = h.connect();
  client.bufferedAmount = 1024 * 1024;
  h.sendPluginMessageTo(client, 'PushoverWatchdog:config', {});
  assert.equal(client.sent.length, 0);
  assert.equal(client.readyState, 3);
});

test('repeated unauthenticated actions throttle both reply and warning', async t => {
  const h = harness(t);
  const { client } = h.connect();
  for (let i = 0; i < 10; i++) { client.emit('message', frame('getConfig')); await flush(); }
  assert.equal(client.sent.length, 1);
  assert.equal(h.warnings.length, 1);
  h.advance(5000);
  client.emit('message', frame('getConfig'));
  await flush();
  assert.equal(client.sent.length, 2);
});

test('normal admin read and RadioText request are delivered in order', async t => {
  const h = harness(t);
  const { client } = h.connect({ isAdminAuthenticated: true, reload(cb) { cb(); } });
  client.emit('message', frame('getConfig'));
  client.emit('message', frame('getRtLog'));
  await flush();
  assert.deepEqual(client.sent.map(x => x.type), ['PushoverWatchdog:channel', 'PushoverWatchdog:config', 'PushoverWatchdog:rtLogPage']);
  const config = client.sent[1].value;
  assert.equal('pushoverUserKey' in config, false);
  assert.equal('telegramBotToken' in config, false);
});

test('logout during reload prevents privileged response', async t => {
  const h = harness(t);
  let complete;
  const session = { isAdminAuthenticated: true, reload(cb) { complete = cb; } };
  const { client } = h.connect(session);
  client.emit('message', frame('getConfig'));
  session.isAdminAuthenticated = false;
  complete();
  await flush();
  assert.equal(client.sent.filter(x => x.type === 'PushoverWatchdog:config').length, 0);
});

test('disconnect during reload discards queued work and stale responses', async t => {
  const h = harness(t);
  let complete;
  const { client } = h.connect({ isAdminAuthenticated: true, reload(cb) { complete = cb; } });
  client.emit('message', frame('getConfig'));
  client.emit('message', frame('getRtLog'));
  client.close();
  complete();
  await flush();
  assert.equal(client.sent.length, 1);
  assert.equal(h.pluginClientMessageHandlers.size, 0);
});

test('one stalled client retains at most one active action and eight queued actions', async t => {
  const h = harness(t);
  let complete;
  let reloads = 0;
  const { client } = h.connect({ isAdminAuthenticated: true, reload(cb) { reloads++; complete = cb; } });
  for (let i = 0; i < 9; i++) client.emit('message', frame('getConfig'));
  assert.equal(h.stats().active, 1);
  assert.equal(h.stats().pending, 8);
  assert.equal(reloads, 1);
  client.emit('message', frame('getConfig'));
  await flush();
  assert.equal(h.stats().active, 0);
  assert.equal(h.stats().pending, 0);
  assert.equal(h.pluginClientMessageHandlers.size, 0);
  complete();
  await flush();
  assert.equal(client.sent.length, 1, 'only the initial channel token was sent');
});

test('global active sessions remain bounded across many clients', async t => {
  const h = harness(t);
  let reloads = 0;
  const clients = Array.from({ length: 100 }, () => h.connect({ reload() { reloads++; } }).client);
  for (const client of clients) client.emit('message', frame('getConfig'));
  assert.equal(reloads, 64);
  assert.equal(h.stats().active, 64);
  assert.equal(h.stats().pending, 0);
  for (const client of clients) client.close();
  await flush();
  assert.equal(h.stats().active, 0);
  assert.equal(h.pluginClientMessageHandlers.size, 0);
});

test('global pending actions remain bounded while independent workers are stalled', async t => {
  const h = harness(t);
  const clients = Array.from({ length: 64 }, () => h.connect({ reload() {} }).client);
  for (const client of clients) client.emit('message', frame('getConfig'));
  // Let the shared action budget recover while all workers remain blocked.
  for (const client of clients) {
    h.advance(2000);
    for (let j = 0; j < 8; j++) client.emit('message', frame('getRtLog'));
    assert.ok(h.stats().pending <= 256);
  }
  assert.equal(h.stats().pending, 256);
  for (const client of clients) client.close();
  await flush();
  assert.equal(h.stats().pending, 0);
  assert.equal(h.stats().active, 0);
});

test('session refresh timeout drains bounded work without leaving active workers', async t => {
  const h = harness(t);
  const { client } = h.connect({ reload() {} });
  client.emit('message', frame('getConfig'));
  const timeout = [...h.timers].find(x => x.delay === 5000);
  assert.ok(timeout);
  timeout.fn();
  await flush();
  assert.equal(h.stats().active, 0);
  assert.equal(client.sent[0].type, 'PushoverWatchdog:toast');
});

test('runtime stop clears pending actions, refresh timers and shared listeners', async t => {
  const h = harness(t);
  const { client } = h.connect({ reload() {} });
  client.emit('message', frame('getConfig'));
  client.emit('message', frame('getRtLog'));
  h.runtime.stop();
  await flush();
  assert.equal(h.stats().active, 0);
  assert.equal(h.stats().pending, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.wss.listenerCount('connection'), 0);
  assert.equal(client.listenerCount('message'), 0);
  assert.equal(client.sent.length, 0);
});

test('malformed and unrelated frames do not start authentication work', async t => {
  const h = harness(t);
  let reloads = 0;
  const { client } = h.connect({ reload() { reloads++; } });
  for (const value of ['{', 'null', '[]', '"x"', '{"type":42}', '{"type":"AnotherPlugin:getConfig"}', '{"type":"PushoverWatchdog:unknown"}']) {
    client.emit('message', Buffer.from(value));
  }
  await flush();
  assert.equal(reloads, 0);
  assert.equal(h.stats().pending, 0);
  assert.equal(client.sent.length, 0);
});

test('frame-count limit covers even malformed input before parsing', t => {
  const h = harness(t);
  const { client } = h.connect();
  for (let i = 0; i < 201; i++) client.emit('message', Buffer.from('{'));
  assert.equal(client.readyState, 1);
  assert.equal(h.pluginClientMessageHandlers.size, 0);
  assert.equal(h.pluginClientMessageHandlers.size, 0);
  assert.equal(h.warnings.length, 0);
});

test('byte-rate limit covers bounded-size malformed messages', t => {
  const h = harness(t);
  const { client } = h.connect();
  for (let i = 0; i < 33; i++) client.emit('message', Buffer.alloc(65536, 120));
  assert.equal(client.readyState, 1);
  assert.equal(h.pluginClientMessageHandlers.size, 0);
  assert.equal(h.warnings.length, 0);
});

test('isolated oversized frame is ignored without disrupting the shared transport', t => {
  const h = harness(t);
  const { client } = h.connect();
  client.emit('message', Buffer.alloc(65537));
  assert.equal(client.readyState, 1);
  assert.equal(client.sent.length, 0);
  assert.equal(h.warnings.length, 0);
});

test('connection churn has bounded plugin attachment and global warning output', async t => {
  const h = harness(t);
  let attached = 0;
  for (let i = 0; i < 1000; i++) {
    const { client } = h.connect();
    if (client.listenerCount('message')) attached++;
    client.emit('message', frame('getConfig'));
    await flush();
    client.close();
  }
  assert.equal(attached, 128);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.pluginClientMessageHandlers.size, 0);
  h.advance(2000);
  const { client } = h.connect({ isAdminAuthenticated: true });
  client.emit('message', frame('getConfig'));
  await flush();
  assert.ok(client.sent.some(x => x.type === 'PushoverWatchdog:config'));
});

test('UI save and notification test still return their responses', async t => {
  const h = harness(t);
  const { client } = h.connect({ isAdminAuthenticated: true, reload(cb) { cb(); } });
  client.emit('message', Buffer.from(JSON.stringify({ type: 'PushoverWatchdog:saveConfig', value: { signalThreshold: 35, pushoverUserKey: 'injected' } })));
  await flush();
  const cfg = client.sent.filter(x => x.type === 'PushoverWatchdog:config').at(-1).value;
  assert.equal(cfg.signalThreshold, 35);
  assert.equal(cfg.pushoverCredentialsConfigured, false);
  client.emit('message', Buffer.from(JSON.stringify({ type: 'PushoverWatchdog:testChannel', value: { channel: 'unknown' } })));
  await flush();
  assert.ok(client.sent.some(x => x.type === 'PushoverWatchdog:toast' && x.value.message.includes('Unknown notification channel')));
  assert.equal(h.stats().active, 0);
});

test('payload is counted along with existing output buffer before send', t => {
  const h = harness(t);
  const { client } = h.connect();
  client.bufferedAmount = 256 * 1024 - 10;
  h.sendPluginMessageTo(client, 'PushoverWatchdog:toast', { message: 'hello' });
  assert.equal(client.sent.length, 0);
  assert.equal(client.readyState, 3);
});

test('bounded broadcasts still revalidate the administrator session', async t => {
  const h = harness(t);
  let complete;
  const session = { isAdminAuthenticated: true, reload(cb) { complete = cb; } };
  const { client } = h.connect(session);
  h.sendPluginMessage('PushoverWatchdog:status', { enabled: true });
  session.isAdminAuthenticated = false;
  complete();
  await flush();
  assert.equal(client.sent.length, 1);
});

test('invalid Origin cannot access settings or produce unbounded connection warnings', async t => {
  const h = harness(t);
  const { client } = h.connect({ isAdminAuthenticated: true }, { host: 'radio.example', origin: 'https://attacker.example' });
  client.emit('message', frame('getConfig'));
  await flush();
  assert.equal(client.sent.some(x => x.type === 'PushoverWatchdog:config'), false);
  assert.equal(client.sent.some(x => x.type === 'PushoverWatchdog:channel'), false);
  assert.equal(h.warnings.length, 1);
});

test('connection ceiling bounds long-lived plugin state and recovers on close', t => {
  const h = harness(t);
  const clients = [];
  for (let i = 0; i < 600; i++) {
    h.advance(2000);
    clients.push(h.connect().client);
  }
  assert.equal(h.pluginClientMessageHandlers.size, 512);
  assert.equal(clients.at(-1).listenerCount('message'), 0);
  clients[0].close();
  assert.equal(h.connect().client.listenerCount('message'), 1);
  assert.equal(h.pluginClientMessageHandlers.size, 512);
});

test('shared action and frame budgets reject excess work and refill', async t => {
  const h = harness(t);
  const { client } = h.connect({ isAdminAuthenticated: true });
  for (let i = 0; i < 128; i++) { client.emit('message', frame('getConfig')); await flush(); }
  const sent = client.sent.length;
  client.emit('message', frame('getConfig'));
  await flush();
  assert.equal(client.sent.length, sent);
  h.advance(2000);
  client.emit('message', frame('getConfig'));
  await flush();
  assert.equal(client.sent.length, sent + 1);
});

test('per-client frame allowance refills for a sustained normal connection', t => {
  const h = harness(t);
  const { client } = h.connect();
  for (let i = 0; i < 150; i++) client.emit('message', Buffer.from('{'));
  h.advance(2000);
  for (let i = 0; i < 150; i++) client.emit('message', Buffer.from('{'));
  assert.equal(client.readyState, 1);
});

test('blocked host session store does not accumulate timers after socket churn', async t => {
  const h = harness(t);
  const baseline = h.timers.size;
  for (let i = 0; i < 100; i++) {
    const { client } = h.connect({ reload() {} });
    client.emit('message', frame('getConfig'));
    client.close();
    await flush();
    assert.equal(h.stats().active, 0);
    assert.equal(h.timers.size, baseline);
  }
});

test('valid notification tests remain serialized until HTTP completion', async t => {
  const requests = [];
  const h = harness(t, {
    config: { pushoverUserKey: 'synthetic-user', pushoverApiToken: 'synthetic-token' },
    modules: { https: { request(_options, onResponse) {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = error => { if (error) req.emit('error', error); };
      requests.push(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        onResponse(res);
        res.emit('data', Buffer.from('{"status":1}'));
        res.emit('end');
      });
      return req;
    } } }
  });
  const { client } = h.connect({ isAdminAuthenticated: true });
  client.emit('message', frame('test'));
  client.emit('message', frame('test'));
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(h.stats().active, 1);
  assert.equal(h.stats().pending, 1);
  requests[0]();
  await flush();
  assert.equal(requests.length, 2);
  requests[1]();
  await flush();
  assert.equal(h.stats().active, 0);
  assert.equal(client.sent.filter(x => x.type === 'PushoverWatchdog:toast' && x.value.level === 'success').length, 2);
});

test('generic preparse pressure detaches only Watchdog and preserves other listeners', t => {
  const h = harness(t);
  const { client } = h.connect();
  let delivered = 0;
  client.on('message', () => { delivered++; });
  for (let i = 0; i < 201; i++) client.emit('message', Buffer.from('{"type":"OtherPlugin:status"}'));
  assert.equal(client.readyState, 1);
  assert.equal(h.pluginClientMessageHandlers.size, 0);
  assert.equal(delivered, 201);
  assert.equal(client.listenerCount('message'), 1);
});

// Provider-controlled bodies must never enter errors, logs or browser replies.
for (const channel of ['pushover', 'telegram']) {
  test(`${channel} reflected credentials stay out of notification diagnostics`, async t => {
    const secrets = ['synthetic-user-secret', 'synthetic-api-secret', '123456:synthetic-bot-secret'];
    const requests = [];
    const h = harness(t, {
      config: {
        pushoverEnabled: channel === 'pushover', telegramEnabled: channel === 'telegram',
        pushoverUserKey: secrets[0], pushoverApiToken: secrets[1],
        telegramBotToken: secrets[2], telegramChatId: '123456'
      },
      modules: { https: { request(_options, onResponse) {
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => {};
        req.destroy = error => { if (error) req.emit('error', error); };
        requests.push((status, body) => {
          const res = new EventEmitter();
          res.statusCode = status;
          res.destroy = () => {};
          onResponse(res);
          res.emit('data', Buffer.from(body));
          res.emit('end');
        });
        return req;
      } } }
    });
    const reflected = JSON.stringify({ error: secrets.join('\n'), path: `/bot${secrets[2]}/sendMessage` });
    const failure = h.sendTestNotification(channel);
    requests.shift()(401, reflected);
    await assert.rejects(failure, error => {
      assert.match(error.message, /HTTP 401/);
      for (const secret of secrets) assert.equal(error.message.includes(secret), false);
      return true;
    });
    h.dispatchNotifications('Test', 'Message', 'test', 100);
    requests.shift()(429, reflected);
    await flush();
    assert.ok(h.warnings.some(line => line.includes('HTTP 429')));
    const { client } = h.connect({ isAdminAuthenticated: true });
    client.emit('message', Buffer.from(JSON.stringify({ type: 'PushoverWatchdog:testChannel', value: { channel } })));
    await flush();
    requests.shift()(503, reflected);
    await flush();
    assert.ok(client.sent.some(x => x.type === 'PushoverWatchdog:toast' && x.value.level === 'error'));
    const outputs = JSON.stringify({ warnings: h.warnings, sent: client.sent });
    for (const secret of secrets) assert.equal(outputs.includes(secret), false);

    const oversized = h.sendTestNotification(channel);
    requests.shift()(500, reflected + 'x'.repeat(32769));
    await assert.rejects(oversized, /safety limit/);
    const success = h.sendTestNotification(channel);
    requests.shift()(200, '{"ok":true}');
    assert.equal(await success, '{"ok":true}');
  });
}
