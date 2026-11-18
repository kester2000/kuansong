'use strict';
/**
 * part1 -> part2 boundary: spawn the CLI, never import the engine here.
 * Everything that needs the game rules lives behind this process boundary,
 * exactly like the "part2 是纯 CLI 推理" contract.
 */
const { spawn } = require('node:child_process');

class Part2Error extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'Part2Error';
    Object.assign(this, detail);
  }
}

class Part2Client {
  constructor(options) {
    this.node = options.node;
    this.cli = options.cli;
    this.timeoutMs = options.timeoutMs || 180000;
    this.log = options.logger || (() => {});
  }

  run(args, { stdin, timeoutMs } = {}) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.node, [this.cli, ...args], { windowsHide: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Part2Error(`part2 超时（${timeoutMs || this.timeoutMs}ms）`, { code: 'PART2_TIMEOUT' }));
      }, timeoutMs || this.timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Part2Error(`无法启动 part2: ${error.message}`, { code: 'PART2_SPAWN' }));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const elapsed = Date.now() - started;
        let json = null;
        const line = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
        if (line) { try { json = JSON.parse(line); } catch { json = null; } }
        this.log(`part2 ${args[0]} exit=${code} ${elapsed}ms`);
        resolve({ code, json, stdout, stderr, elapsed });
      });
      if (stdin != null) child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
      else child.stdin.end();
    });
  }

  async init({ session, settings, meta }) {
    const args = ['init', '--session', session, '--json'];
    for (const [flag, key] of [
      ['--mode', 'mode'], ['--players', 'players'], ['--self', 'self'], ['--size', 'size'],
      ['--capture-target', 'captureTarget'], ['--pool', 'pool'], ['--exits', 'exitCount'], ['--event', 'event'], ['--group', 'group'], ['--title', 'title'],
    ]) {
      if (settings[key] != null && settings[key] !== '') args.push(flag, String(settings[key]));
    }
    if (settings.silent) args.push('--silent');
    if (settings.roomRules) args.push('--room-rules', JSON.stringify(settings.roomRules));
    if (settings.dark) args.push('--dark');
    if (settings.force) args.push('--force');
    const result = await this.run(args, { timeoutMs: 30000 });
    return this._unwrap(result, 'init');
  }

  async append({ session, text, view, infer = false, budgetMs }) {
    const args = ['append', '--session', session, '--stdin', '--json'];
    if (view != null) args.push('--view', String(view));
    if (infer) args.push('--infer');
    if (budgetMs) args.push('--budget', String(budgetMs));
    const result = await this.run(args, { stdin: JSON.stringify({ text }) });
    return this._unwrap(result, 'append');
  }

  async status(session) {
    const result = await this.run(['status', '--session', session, '--json'], { timeoutMs: 30000 });
    return this._unwrap(result, 'status');
  }

  async qq(session, { budgetMs, heartbeatPaddingRound } = {}) {
    const args = ['qq', '--session', session, '--json'];
    if (heartbeatPaddingRound) args.push('--heartbeat-padding-round', String(heartbeatPaddingRound));
    if (budgetMs) args.push('--budget', String(budgetMs));
    const result = await this.run(args, { timeoutMs: Math.min(this.timeoutMs,45000) });
    return this._unwrap(result, 'qq');
  }

  async review(session, { budgetMs, out } = {}) {
    const args = ['review', '--session', session, '--json'];
    if (budgetMs) args.push('--budget', String(budgetMs));
    if (out) args.push('--out', String(out));
    const result = await this.run(args, { timeoutMs: this.timeoutMs });
    return this._unwrap(result, 'review');
  }

  /** Read the opening block-pool sheet. Writes the pool into `session` when usable. */
  async poolRead({ image, mode, pool, session, force } = {}) {
    const args = ['pool-read', '--image', String(image), '--json'];
    if (mode) args.push('--mode', String(mode));
    if (pool) args.push('--pool', String(pool));
    if (session) args.push('--session', String(session));
    if (force) args.push('--force');
    const result = await this.run(args, { timeoutMs: 120000 });
    return this._unwrap(result, 'pool-read');
  }

  _unwrap(result, action) {
    if (result.json) return result.json;
    const message = result.stderr.trim() || `part2 ${action} 没有返回 JSON（exit ${result.code}）`;
    throw new Part2Error(message, { code: 'PART2_OUTPUT', exitCode: result.code, stderr: result.stderr });
  }
}

module.exports = { Part2Client, Part2Error };
