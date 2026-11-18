'use strict';

const fs = require('node:fs');
const catalog = require('./catalog.cjs');
const observation = require('./observation.cjs');

function rulesFor(game, input) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('options 必须是规则对象');
  }
  const rules = Object.fromEntries(Object.entries(game.rules).map(([key, allowed]) =>
    [key, Array.isArray(allowed) ? allowed[0] : allowed]));
  for (const [key, value] of Object.entries(input ?? {})) {
    const allowed = game.rules[key];
    if (!Object.hasOwn(game.rules, key) || !['string', 'number'].includes(typeof value) ||
        !(Array.isArray(allowed) ? allowed : [allowed]).includes(String(value))) {
      throw new Error('不支持的规则选项：' + key);
    }
    rules[key] = String(value);
  }
  return rules;
}

function entry(id, isMain) {
  const game = catalog.find(id);
  const policy = catalog.load(id);

  function recommend(input, random = Math.random) {
    if (!input || !Number.isInteger(input.players) || input.players < game.min ||
        input.players > game.max || !Number.isInteger(input.self) ||
        input.self < 0 || input.self >= input.players) {
      throw new Error('人数或座位超出支持范围');
    }

    if (!Array.isArray(input.observations) ||
        input.observations.some(item => !item || typeof item.text !== 'string' ||
          (item.private !== undefined && typeof item.private !== 'boolean'))) {
      throw new Error('observations 必须是有效的观察数组');
    }

    const model = policy.init(observation.newModel({
      players: input.players,
      self: input.self,
      options: rulesFor(game, input.options)
    }));
    for (const item of input.observations) {
      observation.observePhase(model, item.text);
      policy.observe(model, item);
    }

    if (id === 'dvalue_tender' &&
        policy.terminal(model.completed ?? 0, model.wins, Number(model.options.回合数)) !== null) {
      return null;
    }

    const action = policy.decide(model, random);
    if (action && (!['private', 'group'].includes(action.channel) || !policy.validate(model, action))) {
      throw new Error('策略返回了不合法的动作');
    }
    return action ?? null;
  }

  if (isMain) {
    try {
      const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
      process.stdout.write(JSON.stringify(recommend(input)) + '\n');
    } catch (error) {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    }
  }

  return { apiVersion: 1, id: game.id, name: game.name, recommend };
}

module.exports = { entry };
