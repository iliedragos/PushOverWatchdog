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
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent = [];
    constructor() { super(); sockets.push(this); }
    addEventListener(name, fn) { this.on(name, fn); }
    send(data) { this.sent.push(JSON.parse(data)); }
    open() { this.readyState = 1; this.emit('open'); }
    close() { this.readyState = 3; this.emit('close'); }
    receive(value) { this.emit('message', { data: JSON.stringify(value) }); }
  }
  const window = { location: { protocol: 'https:', host: 'radio.example', pathname: '/' } };
  const document = { readyState: 'loading', body: {}, querySelector: () => admin ? {} : null, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
  const timer = (fn, ms) => { const handle = { fn, ms }; timers.add(handle); return handle; };
  const context = { window, document, WebSocket: Socket, setTimeout: timer, setInterval: timer, clearTimeout: x => timers.delete(x), clearInterval: x => timers.delete(x) };
  vm.createContext(context);
  const injected = frontend.replace(/\}\)\(\);\s*$/, 'renderModal = () => {}; window.testApi = { connect, runtime, deactivateAdminUi }; })();');
  vm.runInContext(injected, context);
  t.after(() => window.testApi.runtime.stop());
  return { ...window.testApi, timers, sockets, logout: () => { admin = false; }, fire(ms) {
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
