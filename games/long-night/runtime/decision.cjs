'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { validateRequest, validateResponse } = require('../host.cjs').get('decision-policy.cjs');

const redactRouting = text => String(text).replace(/(?:\[CQ:at,[^\]]+\]|\b\d{6,15}\b)/g, '[已去除账号标识]');

function requestFor({ session, journal, messages, self, round, step, target, budgetMs }) {
  const identity = createHash('sha256').update(
    JSON.stringify([session, journal.meta?.createdAt, journal.meta?.openingSeed])
  ).digest('hex');
  const settings = journal.base.config || {};
  const observations = messages.flatMap((message, seq) => {
    if (message.private && message.view !== self) return [];
    return [{
      seq,
      kind: redactRouting(message.type || 'observation'),
      visibility: message.private ? 'self-private' : 'public',
      text: redactRouting(message.text)
    }];
  });
  const rules = Object.fromEntries(['mode', 'playerCount', 'size', 'captureTarget', 'exitCount',
    'event', 'silent', 'dark'].filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));

  return validateRequest({
    apiVersion: 1,
    requestId: randomUUID(),
    gameId: 'long-night',
    matchId: identity,
    observationVersion: Date.parse(journal.meta?.updatedAt),
    budgetMs,
    player: { seat: self, round, step },
    rules,
    observations,
    allowedTargets: [target]
  });
}

async function choose({ policy, request, proposed, retainedTarget }) {
  const response = policy ? await policy.decide(request) : {
    apiVersion: request.apiVersion,
    requestId: request.requestId,
    observationVersion: request.observationVersion,
    status: 'action',
    action: { target: retainedTarget, text: proposed }
  };
  validateResponse(request, response);
  if (response.status === 'wait') return null;
  if (policy && !/^(?:[上下左右]|停止)$/.test(response.action.text)) {
    throw new Error('外部策略仅允许单步或停止');
  }
  return response.action;
}

module.exports = { requestFor, choose };
