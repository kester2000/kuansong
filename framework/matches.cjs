'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const store = require('./storage.cjs');
const artifact = require('./artifact.cjs');
const root = () => path.join(store.dataDir(), 'matches');
function save(session, { endedAt = new Date().toISOString(), actualEndedAt = null, reason = 'game-over', terminalText = '', refresh = false } = {}) {
  const journal = store.load(session);
  if (!journal) return null;
  let board = artifact.load(session) || {};
  try {board=require('./terminal-state.cjs').terminalState(journal,board).board;} catch { /* incomplete old archives keep their original result */ }
  const previous = board.recordId ? read(board.recordId) : null;
  if (previous && !refresh) return board.recordId;
  const prior = previous ? JSON.parse(previous) : null;
  if (prior) { endedAt = prior.endedAt; actualEndedAt = prior.actualEndedAt || actualEndedAt; reason = prior.reason; terminalText = prior.terminalText; }
  const stamp = new Date(new Date(endedAt).getTime() + 8 * 3600000).toISOString().replace('T','_').replace(/[:.]/g,'-').replace('Z','');
  const id = prior ? prior.id : `${stamp}_${session}`;
  const attachments = [];
  const pictures = [...(board.images || [])];
  if (board.pool?.image) pictures.unshift({file:board.pool.image,caption:'开局区块池'});
  const seen = new Set();
  for (const picture of pictures) {
    const file = picture.file;
    if (!file || seen.has(file) || !fs.existsSync(file) || path.dirname(path.resolve(file)) !== path.resolve(store.dataDir(), 'images')) continue;
    seen.add(file);
    const bytes = fs.readFileSync(file);
    const mime = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes[0]===255 && bytes[1]===216 ? 'image/jpeg' : bytes.subarray(0,3).toString()==='GIF' ? 'image/gif' : bytes.subarray(8,12).toString()==='WEBP' ? 'image/webp' : null;
    if (mime) attachments.push({name:path.basename(file),mime,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64'),caption:picture.caption || '机器人图片',at:picture.at,messageId:picture.messageId,phase:picture.phase});
  }
  let reviewMarkdown = null;
  const reviewPath = board.review && board.review.path;
  if (reviewPath && path.dirname(path.resolve(reviewPath)) === path.resolve(store.dataDir(), 'reviews') && fs.existsSync(reviewPath)) reviewMarkdown = fs.readFileSync(reviewPath,'utf8');
  const terminal=journal.messages.find(m=>/玩家剩余[^\n]*游戏结束|所有玩家均主动停止[^\n]*游戏结束/.test(m.text));
  const journalActualEndedAt=terminal?.source?.time?new Date(terminal.source.time*1000).toISOString():null;
  const summary = { id, session, endedAt, actualEndedAt:actualEndedAt || journalActualEndedAt, timezone:'Asia/Shanghai', reason, result:board.review?.result || '未判定', mode:board.settings?.modeName || board.settings?.mode || journal.base?.config?.mode, messages:journal.messages.length, rounds:board.report?.progress?.rounds || [] };
  const record = { version:1, ...summary, terminalText, journal, board, reviewMarkdown, attachments };
  fs.mkdirSync(root(),{recursive:true});
  const target = path.join(root(),id+'.json'), tmp = target+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(record,null,2)); fs.renameSync(tmp,target);
  fs.writeFileSync(path.join(root(),id+'.md'),`# 长夜对局记录 · ${id}\n\n- 结束时间：${endedAt}（文件名为北京时间）\n- 模式：${summary.mode}\n- 结果：${summary.result}\n- 收尾原因：${reason}\n- 消息：${summary.messages}\n\n## 终局原文\n\n${terminalText}\n\n${reviewMarkdown || '未生成推理复盘；原始线索仍完整保存在同名 JSON 的 journal 中。'}\n\n逐步复盘：[行动目的与实际反馈](${id}.decisions.md)\n\n完整记录：${id}.json\n`);
  fs.writeFileSync(path.join(root(),id+'.html'),render(record));
  artifact.save(session,{...board,recordId:id});
  return id;
}
const {render}=require('./game.cjs').module('runtime/archive.cjs');
function list() {
  if (!fs.existsSync(root())) return [];
  return fs.readdirSync(root()).filter(n=>n.endsWith('.json')).sort().reverse().map(n=>{
    try { const r=JSON.parse(fs.readFileSync(path.join(root(),n),'utf8')); return {id:r.id,session:r.session,endedAt:r.endedAt,mode:r.mode,result:r.result,messages:r.messages,reason:r.reason}; } catch { return null; }
  }).filter(Boolean);
}
function read(id) { if (!/^[A-Za-z0-9_-]+$/.test(id)) return null; const p=path.join(root(),id+'.json');return fs.existsSync(p)?fs.readFileSync(p,'utf8'):null; }
module.exports={save,list,read,render};
