'use strict';

const { spawn } = require('node:child_process');

const targets = new Set(['referee-private', 'match-group']);
const maxBytes = 1024 * 1024;

class DecisionPolicy {
  decide() {
    throw new Error('DecisionPolicy.decide must be implemented');
  }
}

function validateRequest(request) {
  if (!request || request.apiVersion !== 1 || request.gameId !== 'long-night' ||
      typeof request.requestId !== 'string' || !request.requestId ||
      typeof request.matchId !== 'string' || !request.matchId ||
      !Number.isSafeInteger(request.observationVersion) || request.observationVersion < 0 ||
      !Number.isSafeInteger(request.budgetMs) || request.budgetMs < 1 ||
      !Number.isInteger(request.player?.seat) || request.player.seat < 0 ||
      !request.rules || typeof request.rules !== 'object' || Array.isArray(request.rules) ||
      !Array.isArray(request.allowedTargets) ||
      request.allowedTargets.some(target => !targets.has(target)) ||
      !Array.isArray(request.observations)) {
    throw new Error('Invalid decision request');
  }
  let seq = -1;
  for (const observation of request.observations) {
    if (!observation || !Number.isSafeInteger(observation.seq) || observation.seq <= seq ||
        !['public', 'self-private'].includes(observation.visibility) ||
        typeof observation.text !== 'string' || typeof observation.kind !== 'string') {
      throw new Error('Invalid decision observation');
    }
    seq = observation.seq;
  }
  return request;
}

function validateResponse(request, response) {
  if (!response || response.apiVersion !== request.apiVersion ||
      response.requestId !== request.requestId ||
      response.observationVersion !== request.observationVersion) {
    throw new Error('Decision response does not match request');
  }
  const keys = Object.keys(response);
  const common = ['apiVersion', 'requestId', 'observationVersion', 'status', 'reason'];
  if (response.reason !== undefined && typeof response.reason !== 'string') {
    throw new Error('Invalid decision reason');
  }
  if (response.status === 'wait' && keys.every(key => common.includes(key))) return response;
  const action = response.action;
  if (response.status === 'action' && keys.every(key => key === 'action' || common.includes(key)) &&
      action && Object.keys(action).every(key => ['target', 'text', 'reason'].includes(key)) &&
      request.allowedTargets.includes(action.target) && typeof action.text === 'string' &&
      action.text.trim() && (action.reason === undefined || typeof action.reason === 'string')) {
    return response;
  }
  throw new Error('Invalid decision action');
}

class ProcessDecisionPolicy extends DecisionPolicy {
  constructor({ program, args = [] }) {
    super();
    if (typeof program !== 'string' || !program || !Array.isArray(args) ||
        args.some(arg => typeof arg !== 'string')) {
      throw new Error('Invalid external decision program');
    }
    this.program = program;
    this.args = [...args];
  }

  decide(request) {
    return new Promise((resolve, reject) => {
      const input = JSON.stringify(validateRequest(request)) + '\n';
      if (Buffer.byteLength(input) > maxBytes) throw new Error('Decision request exceeds byte limit');
      const separateGroup = process.platform !== 'win32';
      const child = spawn(this.program, this.args, {
        shell: false, windowsHide: true, detached: separateGroup,
        env: Object.fromEntries(Object.entries(process.env)
          .filter(([key]) => /^(?:path|systemroot|windir|temp|tmp|lang)$/i.test(key)))
      });
      let output = [];
      let length = 0;
      let diagnosticLength = 0;
      const fail = error => {
        clearTimeout(timer);
        if (child.pid) {
          try {
            if (separateGroup) process.kill(-child.pid, 'SIGKILL');
            else {
              const stop = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true, stdio: 'ignore'
              });
              stop.on('error', () => child.kill());
              stop.on('exit', code => { if (code !== 0) child.kill(); });
            }
          } catch { child.kill(); }
        }
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('Decision timed out')), request.budgetMs);
      child.stdout.on('data', chunk => {
        length += chunk.length;
        if (length > maxBytes) fail(new Error('Decision response exceeds byte limit'));
        else output.push(chunk);
      });
      child.stderr.on('data', chunk => {
        diagnosticLength += chunk.length;
        if (diagnosticLength > maxBytes) fail(new Error('Decision diagnostics exceed byte limit'));
      });
      child.stdin.on('error', error => fail(error));
      child.on('error', fail);
      child.on('close', code => {
        clearTimeout(timer);
        try {
          if (code !== 0) throw new Error('Decision program failed');
          const line = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output)).trim();
          output = [];
          if (!line || /[\r\n]/.test(line)) throw new Error('Expected one JSON response line');
          resolve(validateResponse(request, JSON.parse(line)));
        } catch (error) { reject(error); }
      });
      child.stdin.end(input);
    });
  }
}

module.exports = { DecisionPolicy, ProcessDecisionPolicy, validateRequest, validateResponse };
