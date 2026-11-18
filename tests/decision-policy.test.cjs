'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ProcessDecisionPolicy } = require('../framework/decision-policy.cjs');
require('../framework/game.cjs');
const { requestFor, choose } = require('../games/long-night/runtime/decision.cjs');

const request = requestFor({
  session: 'fixture', journal: { base: {}, meta: { updatedAt: '2026-11-18T00:00:00Z' } },
  messages: [
    { private: true, view: 1, text: '另一个席位' },
    { private: true, view: 0, text: '本人观察' },
    { private: false, text: '公开观察 [CQ:at,qq=123456789]' }
  ],
  self: 0, round: 1, step: 1, target: 'match-group', budgetMs: 1500
});

test('decision request includes only authorized observations and hides routing', () => {
  assert.deepEqual(request.observations.map(item => item.text), ['本人观察', '公开观察 [已去除账号标识]']);
});

test('built-in suggestion crosses the same response validation', async () => {
  assert.deepEqual(await choose({ request, proposed: '上', retainedTarget: 'match-group' }), {
    target: 'match-group', text: '上'
  });
});

function external(action) {
  const program = `
    const q=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
    console.log(JSON.stringify({apiVersion:1,requestId:q.requestId,observationVersion:q.observationVersion,${action}}));
  `;
  return new ProcessDecisionPolicy({ program: process.execPath, args: ['-e', program] });
}

test('external process wait and action', async () => {
  assert.equal(await choose({ request, policy: external("status:'wait'") }), null);
  assert.equal((await choose({ request, policy: external("status:'action',action:{target:'match-group',text:'左'}") })).text, '左');
});

test('wrong route and invalid command fail closed', async () => {
  await assert.rejects(choose({ request, policy: external("status:'action',action:{target:'referee-private',text:'上'}") }));
  await assert.rejects(choose({ request, policy: external("status:'action',action:{target:'match-group',text:'/退出'}") }));
});

test('subprocess deadline aborts the decision', async () => {
  const policy = new ProcessDecisionPolicy({ program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
  await assert.rejects(policy.decide({ ...request, budgetMs: 100 }), /timed out/);
});
