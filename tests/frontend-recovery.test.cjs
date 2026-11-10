'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const frontend = fs.readFileSync(path.resolve(__dirname, '../plugin/PushoverWatchdog/pushover-watchdog.js'), 'utf8');

function harness(t) {
  const timers = new Set();
  const sockets = [];
  let admin = true;
  let now = 0;
  let parses = 0;
  let adminChecks = 0;
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent = [];
    constructor() { super(); sockets.push(this); }
    addEventListener(name, fn) { this.on(name, fn); }
    send(data) { this.sent.push(JSON.parse(data)); }
    open() { this.readyState = 1; this.emit('open'); }
    close() { if (this.deferClose) { this.readyState = 2; return; } this.finishClose(); }
    finishClose() { this.readyState = 3; this.emit('close'); }
    raw(data) { this.emit('message', { data }); }
    receive(value) { this.emit('message', { data: JSON.stringify(value) }); }
  }
  const window = { location: { protocol: 'https:', host: 'radio.example', pathname: '/' } };
  const document = { readyState: 'loading', body: {}, querySelector: () => { adminChecks++; return admin ? {} : null; }, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
  const timer = (fn, ms) => { const handle = { fn, ms }; timers.add(handle); return handle; };
  const context = { performance: { now: () => now }, JSON: { parse(value) { parses++; return JSON.parse(value); }, stringify: JSON.stringify }, window, document, WebSocket: Socket, setTimeout: timer, setInterval: timer, clearTimeout: x => timers.delete(x), clearInterval: x => timers.delete(x) };
  vm.createContext(context);
  const injected = frontend.replace(/\}\)\(\);\s*$/, 'renderModal = () => {}; ensureRtLogModal = () => ({ classList: { contains: () => true } }); window.testApi = { connect, runtime, deactivateAdminUi, snapshot: () => ({ config, status, rtLogEntries }) }; })();');
  vm.runInContext(injected, context);
  t.after(() => window.testApi.runtime.stop());
  return { ...window.testApi, timers, sockets, parses: () => parses, adminChecks: () => adminChecks, advance: ms => { now += ms; }, logout: () => { admin = false; }, fire(ms) {
    const handle = [...timers].find(x => x.ms === ms);
    assert.ok(handle, `expected ${ms}ms timer`);
    timers.delete(handle);
    handle.fn();
  } };
}

test('missing initial config closes only the plugin-owned socket and reconnects', t => {
  const h = harness(t);
  h.connect();
  h.sockets[0].open();
  h.fire(10000);
  assert.equal(h.sockets[0].readyState, 3);
  h.fire(5000);
  assert.equal(h.sockets.length, 2);
});

test('initial token without config still times out after dropped action admission', t => {
  const h = harness(t);
  h.connect();
  h.sockets[0].open();
  h.sockets[0].receive({ type: 'PushoverWatchdog:channel', value: { token: 'a'.repeat(32) } });
  h.fire(10000);
  assert.equal(h.sockets[0].readyState, 3);
});

test('authenticated initial config cancels reconnect timeout', t => {
  const h = harness(t);
  h.connect();
  h.sockets[0].open();
  h.sockets[0].receive({ type: 'PushoverWatchdog:channel', value: { token: 'a'.repeat(32) } });
  h.sockets[0].receive({ type: 'PushoverWatchdog:config', channelToken: 'a'.repeat(32), value: {} });
  assert.equal([...h.timers].filter(x => x.ms === 10000).length, 0);
  assert.equal(h.sockets[0].readyState, 1);
});

test('logout clears pending configuration timeout and reconnect timers', t => {
  const h = harness(t);
  h.connect();
  h.sockets[0].open();
  h.logout();
  h.deactivateAdminUi();
  assert.equal(h.timers.size, 0);
  assert.equal(h.sockets[0].readyState, 3);
});


test('wrong-token flood closes before unbounded JSON parsing and ignores queued events', t => {
  const h = harness(t);
  h.connect();
  const socket = h.sockets[0];
  socket.open();
  socket.receive({ type: 'PushoverWatchdog:channel', value: { token: 'a'.repeat(32) } });
  for (let i = 0; i < 10000; i++) socket.raw('{"type":"PushoverWatchdog:config","channelToken":"wrong","value":{}}');
  assert.equal(socket.readyState, 3);
  assert.ok(h.parses() <= 200);
  assert.equal(h.snapshot().config, null);
  assert.equal([...h.timers].filter(x => x.ms === 10000).length, 0);
});

test('cumulative text volume is bounded before parsing malformed large frames', t => {
  const h = harness(t);
  h.connect();
  const socket = h.sockets[0];
  socket.open();
  for (let i = 0; i < 100; i++) socket.raw('x'.repeat(65536));
  assert.equal(socket.readyState, 3);
  assert.ok(h.parses() <= 16);
});

test('oversized and binary floods count toward admission without JSON parsing', t => {
  for (const data of ['x'.repeat(65537), new Uint8Array(8)]) {
    const h = harness(t);
    h.connect();
    const socket = h.sockets[0];
    socket.open();
    for (let i = 0; i < 300; i++) socket.raw(data);
    assert.equal(socket.readyState, 3);
    assert.equal(h.parses(), 0);
  }
});

test('repeated floods back off reconnects with a ceiling and recover after a stable connection', t => {
  const h = harness(t);
  h.connect();
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    const socket = h.sockets.at(-1);
    socket.open();
    for (let i = 0; i < 201; i++) socket.raw('{');
    assert.equal(socket.readyState, 3);
    h.advance(delay);
    h.fire(delay);
  }
  const socket = h.sockets.at(-1);
  socket.open();
  socket.receive({ type: 'PushoverWatchdog:channel', value: { token: 'b'.repeat(32) } });
  socket.receive({ type: 'PushoverWatchdog:config', channelToken: 'b'.repeat(32), value: { enabled: true } });
  assert.equal(h.snapshot().config.enabled, true);
  h.advance(60000);
  socket.close();
  h.fire(5000);
});

test('normal sustained traffic refills admission and accepts config only with the current token', t => {
  const h = harness(t);
  h.connect();
  const socket = h.sockets[0];
  socket.open();
  socket.receive({ type: 'PushoverWatchdog:channel', value: { token: 'a'.repeat(32) } });
  socket.receive({ type: 'PushoverWatchdog:config', channelToken: 'wrong', value: { enabled: false } });
  assert.equal(h.snapshot().config, null);
  for (let batch = 0; batch < 10; batch++) {
    for (let i = 0; i < 100; i++) socket.raw('{');
    h.advance(2000);
  }
  socket.receive({ type: 'PushoverWatchdog:config', channelToken: 'a'.repeat(32), value: { enabled: true } });
  assert.equal(h.snapshot().config.enabled, true);
  assert.equal(socket.readyState, 1);
});


test('legitimate config status and history survive interleaved rejected traffic below the budget', t => {
  const h = harness(t);
  h.connect();
  const socket = h.sockets[0];
  socket.open();
  const token = 'a'.repeat(32);
  socket.receive({ type: 'PushoverWatchdog:channel', value: { token } });
  for (let i = 0; i < 100; i++) socket.receive({ type: 'OtherPlugin:status', channelToken: 'wrong', value: {} });
  socket.receive({ type: 'PushoverWatchdog:config', channelToken: token, value: { enabled: true } });
  socket.receive({ type: 'PushoverWatchdog:status', channelToken: token, value: { signal: 42 } });
  const entries = Array.from({ length: 100 }, (_, i) => ({ rt: `Artist ${i} - Song`, timestamp: '2026-11-10T12:00:00Z' }));
  socket.receive({ type: 'PushoverWatchdog:rtLogPage', channelToken: token, value: { entries, hasMore: true, nextBefore: '2026-11-10T12:00:00Z' } });
  assert.equal(h.snapshot().config.enabled, true);
  assert.equal(h.snapshot().status.signal, 42);
  assert.equal(h.snapshot().rtLogEntries.length, 100);
  assert.equal(h.snapshot().rtLogEntries[99].rt, 'Artist 99 - Song');
  assert.equal(socket.readyState, 1);
});

test('cooldown cannot be bypassed by connect and logout cancels recovery', t => {
  const h = harness(t);
  h.connect();
  const socket = h.sockets[0];
  socket.open();
  for (let i = 0; i < 201; i++) socket.raw('{');
  h.connect();
  assert.equal(h.sockets.length, 1);
  h.logout();
  h.deactivateAdminUi();
  assert.equal(h.timers.size, 0);
  h.connect();
  assert.equal(h.sockets.length, 1);
});


test('queued frames stop parsing and DOM checks while browser close is asynchronous', t => {
  const h = harness(t);
  h.connect();
  const socket = h.sockets[0];
  socket.open();
  socket.deferClose = true;
  const checks = h.adminChecks();
  for (let i = 0; i < 10000; i++) socket.raw('{');
  assert.equal(socket.readyState, 2);
  assert.ok(h.parses() <= 200);
  assert.ok(h.adminChecks() - checks <= 200);
  socket.finishClose();
  h.fire(5000);
  assert.equal(h.sockets.length, 2);
});
