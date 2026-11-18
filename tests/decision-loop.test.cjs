'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
process.env.LN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kuansong-loop-'));
const { LongNightBot, StateStore } = require('../framework/bot.cjs');
const store = require('../games/long-night/night-strategist/store.cjs');
const artifact = require('../framework/artifact.cjs');
const matches = require('../framework/matches.cjs');

test('two turns cross decision and send guards, preserve receipts and close into an archive', async () => {
  const sent = [];
  const session = 'g42';
  const groupId = '42';
  const state = new StateStore(path.join(process.env.LN_DATA_DIR, 'state.json'));
  const config = {
    onebot: { selfId: '100' }, control: { gameBotId: '99' },
    behavior: { mode: 'auto', autoMove: true, maxInferPerMinute: 10 }
  };
  const bot = new LongNightBot({
    config, state,
    part2: { qq: async () => ({ ok: true, report: { self: 0, suggestion: {} } }) },
    send: async message => { sent.push(message); return { message_id: 900 + sent.length }; },
    logger: () => {}
  });
  bot.moveChar = () => '上';
  bot.throttle = async () => {};
  state.setGroup(groupId, { session, gameBotId: '99', self: 0, joinReserved: true });
  store.save(session, { base: { config: { playerCount: 2 } }, messages: [], view: 0 });

  for (const step of [1, 2]) {
    artifact.addMessage(session, { view: 0, private: true, text: '本人行动反馈' });
    const turn = { round: 1, steps: Array(step).fill({}), sent: false, promptId: String(step) };
    bot.turns.set(groupId, turn);
    await bot.runInfer({ groupId, event: {}, auto: true });
    assert.ok(turn.sent, artifact.load(session)?.execution?.message);
    assert.equal(state.group(groupId).lastActionPromptId, String(step));
  }
  assert.deepEqual(sent.map(message => message.type), ['group', 'group']);
  assert.deepEqual(artifact.load(session).actions.map(action => action.receiptId), [901, 902]);
  await bot.onGameEnd({ groupId, event: { time: 1800000000 } });
  assert.equal(state.group(groupId).ended, true);
  assert.equal(state.group(groupId).joinReserved, false);
  const record = JSON.parse(matches.read(artifact.load(session).recordId));
  assert.deepEqual(record.board.actions.map(action => action.receiptId), [901, 902]);
});
