'use strict';
/**
 * Minimal OneBot v11 WebSocket client (SnowLuma-compatible).
 *
 * - connects to SnowLuma's ws server (default ws://127.0.0.1:3001/)
 * - authenticates with `?access_token=` (SnowLuma accepts query or Bearer)
 * - correlates actions with a unique `echo`
 * - reconnects with exponential backoff and reports state changes
 *
 * Node >= 22 ships a global WebSocket, so this file has no dependencies.
 */
const { EventEmitter } = require('node:events');

class OneBotError extends Error {
  constructor(message, { retcode, wording, action } = {}) {
    super(message);
    this.name = 'OneBotError';
    this.retcode = retcode;
    this.wording = wording;
    this.action = action;
  }
}

class OneBotClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url || 'ws://127.0.0.1:3001/';
    this.accessToken = options.accessToken || '';
    this.timeoutMs = options.timeoutMs || 20000;
    this.reconnect = options.reconnect !== false;
    this.log = options.logger || ((...args) => console.log('[onebot]', ...args));
    this.ws = null;
    this.pending = new Map();
    this.echoCounter = 0;
    this.state = 'idle';
    this.attempt = 0;
    this.closedByUser = false;
    this._reconnectTimer = null;
  }

  get endpoint() {
    if (!this.accessToken) return this.url;
    const url = new URL(this.url);
    url.searchParams.set('access_token', this.accessToken);
    return url.toString();
  }

  _setState(state, detail) {
    this.state = state;
    this.emit('state', { state, detail });
  }

  connect() {
    this.closedByUser = false;
    this._setState('connecting');
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.endpoint);
      } catch (error) {
        reject(error);
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`连接 ${this.url} 超时`));
      }, this.timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.attempt = 0;
        this._setState('open');
        if (!settled) { settled = true; resolve(); }
      });
      ws.addEventListener('message', (event) => this._onMessage(event));
      ws.addEventListener('error', (event) => {
        const error = new Error(`WebSocket 错误: ${(event && event.message) || 'unknown'}`);
        if (this.listenerCount('error')) this.emit('error', error);
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
        if (this.reconnect && !this.closedByUser) this._scheduleReconnect();
      });
      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        this._setState('closed', { code: event && event.code, reason: event && event.reason });
        this._failPending(new OneBotError(`连接已关闭 (${event && event.code})`));
        this.ws = null;
        if (!settled) { settled = true; reject(new Error(`连接 ${this.url} 被拒绝：${event && event.reason || 'closed'}`)); }
        if (this.reconnect && !this.closedByUser) this._scheduleReconnect();
      });
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** (this.attempt - 1), 30000);
    this._setState('reconnecting', { delay, attempt: this.attempt });
    this.log(`将在 ${delay}ms 后重连（第 ${this.attempt} 次）`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this.closedByUser) return;
      this.connect().catch((error) => this.log(`重连失败: ${error.message}`));
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _onMessage(event) {
    const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.log('收到非 JSON 帧，已忽略');
      return;
    }
    if (payload && payload.echo !== undefined && this.pending.has(String(payload.echo))) {
      const waiter = this.pending.get(String(payload.echo));
      this.pending.delete(String(payload.echo));
      clearTimeout(waiter.timer);
      if (payload.retcode === 0 || payload.retcode === undefined && payload.status === 'ok') waiter.resolve(payload.data);
      else waiter.reject(new OneBotError(`${waiter.action} 失败: ${payload.wording || payload.retcode}`, { retcode: payload.retcode, wording: payload.wording, action: waiter.action }));
      return;
    }
    if (payload && payload.post_type) {
      this.emit('event', payload);
      if (payload.post_type === 'meta_event') this.emit('meta', payload);
      else if (payload.post_type === 'message') this.emit('message', payload);
      else if (payload.post_type === 'message_sent') this.emit('message_sent', payload);
      else if (payload.post_type === 'notice') this.emit('notice', payload);
      else if (payload.post_type === 'request') this.emit('request', payload);
      return;
    }
    this.emit('unknown', payload);
  }

  _failPending(error) {
    for (const [echo, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(echo);
    }
  }

  call(action, params = {}, options = {}) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new OneBotError(`尚未连接，无法调用 ${action}`, { action }));
    }
    const echo = `c${++this.echoCounter}`;
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new OneBotError(`${action} 超时（${timeoutMs}ms）`, { action }));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(echo, { resolve, reject, timer, action });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      }
    });
  }

  sendGroup(groupId, message) {
    const image=Array.isArray(message)&&message.some(m=>m.type==='image');
    return this.call('send_group_msg', { group_id: Number(groupId), message }, image?{timeoutMs:120000}:{});
  }

  sendPrivate(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }

  async login() {
    const info = await this.call('get_login_info');
    return { userId: info && info.user_id, nickname: info && info.nickname };
  }

  close() {
    this.closedByUser = true;
    this._failPending(new OneBotError('客户端已关闭'));
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this._setState('closed');
  }
}

module.exports = { OneBotClient, OneBotError };
