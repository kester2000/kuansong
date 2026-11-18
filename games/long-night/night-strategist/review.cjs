'use strict';
/**
 * Post-game review: one markdown file per game, plus a short QQ summary.
 * Everything comes from the same report the live suggestions use, so a review
 * never claims more than the search actually proved.
 */
const { E, A } = require('./kernel.cjs');
const { renderText } = require('./report.cjs');

function playerTable(statuses, self) {
  const rows = ['| 玩家 | 状态 | 追捕目标 | 被谁追捕 | 已录回合 |', '| --- | --- | --- | --- | --- |'];
  for (const row of statuses || []) {
    const name = `${row.id}号${row.id === self ? '（本人）' : ''}`;
    const state = row.alive ? '存活' : row.reason || '已退场';
    rows.push(`| ${name} | ${state} | ${row.target == null ? '—' : row.target + '号'} | ${row.hunter == null || row.hunter < 0 ? '—' : row.hunter + '号'} | ${row.round ?? 0} |`);
  }
  return rows.join('\n');
}

function buildReview({ journal, report, built }) {
  const s = report.settings;
  const statuses = (() => { try { return A.status(built); } catch { return []; } })();
  const me = statuses.find((row) => row.id === report.self) || {};
  const result = require('./outcome.cjs').outcome(journal).result;
  const position = report.position
    ? `第 ${report.position.r + 1} 行第 ${report.position.c + 1} 列${report.position.relativeText ? `（相对出生 ${report.position.relativeText}）` : ''}`
    : '未知';
  const rounds = report.progress.rounds.length ? report.progress.rounds.join('、') : '—';
  const lines = [
    `# 长夜复盘 · 本人 ${report.self}号`,
    '',
    `- 时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `- 模式：${s.modeName} · ${s.players} 人 · ${s.size}×${s.size}${s.silent ? ' · 静音' : ''}`,
    `- 事件：${s.event === 'NONE' ? '无' : s.event} · 逃生舱：${s.exitCount ?? '未记录'}`,
    `- 区块池：${s.poolCount} 块${s.poolSource === 'auto' ? '（该模式全池，自动）' : ''}`,
    `- 回合：${rounds} · 消息：${report.progress.messages} 条`,
    `- 结果：${result}`,
    `- 最终位置：${position}`,
    '',
    '## 地图验证',
    '',
    `- 整图候选：${report.maps.count}${report.maps.complete ? ' 张（已穷举）' : '+ （未穷举）'}`,
    `- 已确定区块：${report.blocks.determined.length} 个`,
  ];
  for (const block of report.blocks.determined) {
    lines.push(`  - ${block.id}「${block.name}」@ 第 ${block.origin.r + 1} 行 第 ${block.origin.c + 1} 列`);
  }
  lines.push('', '## 玩家状态', '', playerTable(statuses, report.self), '');
  lines.push('## 待核对线索', '');
  if (report.questions.length) for (const q of report.questions) lines.push(`- [${q.kind}] ${q.prompt}`);
  else lines.push('- 无');
  lines.push('', '## 推理给出的建议', '');
  const suggestion = report.suggestion;
  if (suggestion && suggestion.primary) {
    lines.push(`- 方向：${suggestion.primary.arrow}${suggestion.primary.label}（${suggestion.confidence}）`);
    for (const item of [...suggestion.primary.gains, ...suggestion.primary.reasons].slice(0, 4)) lines.push(`  - ${item}`);
    if (suggestion.plan) lines.push(`- 两步推演：${suggestion.plan.text}`);
  } else {
    lines.push('- 无');
  }
  if (report.advice.length) {
    lines.push('', '## 引擎提示', '');
    for (const line of report.advice) lines.push(`- ${line}`);
  }
  lines.push('', '## 消息原文', '');
  for (const message of journal.messages) {
    const first = String(message.text).split('\n').filter(Boolean)[0] || '';
    lines.push(`- \`${message.id}\`${message.view != null ? `（视角 ${message.view}）` : ''} ${first.slice(0, 80)}`);
  }
  lines.push('', '<details><summary>完整报告（文本）</summary>', '', '```text', renderText(report), '```', '', '</details>', '');

  const summary = [
    `【长夜复盘】本人 ${report.self}号 · ${s.modeName} ${s.players}人`,
    `结果：${result} · 共 ${rounds} 回合 · 已确定区块 ${report.blocks.determined.length}`,
    `最终位置：${position}`,
    `待核对线索：${report.questions.length} 条`,
  ].join('\n');
  return { markdown: lines.join('\n'), summary, result, rounds };
}

module.exports = { buildReview, playerTable };
