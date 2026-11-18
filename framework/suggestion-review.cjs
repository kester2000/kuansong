'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const TEMPLATES = Object.freeze({
  unrelated: '这里只接收漫漫长夜的游戏建议，其他内容暂不处理。',
  invalid: '这条建议暂未通过审核，本次不纳入改进记录。',
  valid: '建议已记录，之后会由管理员二次审核处理。',
  pending: '建议审核暂时不可用，内容已保存，稍后自动重试。',
});
function mention(event, self) {
  if (!self) return false;
  const parts = Array.isArray(event.message) ? event.message : [];
  if (parts.some(p => p.type === 'at' && String(p.data?.qq) === String(self))) return true;
  const raw = typeof event.message === 'string' ? event.message : event.raw_message || '';
  return [...raw.matchAll(/\[CQ:at,qq=(\d+)(?:,[^\]]*)?\]/g)].some(m => m[1] === String(self));
}
function textOf(event) {
  return (Array.isArray(event.message) ? event.message.map(p => p.type === 'text' ? p.data?.text || '' : p.type === 'image' ? '[图片：未进行图像审核]' : '').join('') : String(event.message || event.raw_message || '').replace(/\[CQ:[^\]]*\]/g, '')).trim();
}
function eligible(event, bot, config) {
  if (!event || event.post_type !== 'message' || event.message_type !== 'group' || event.message_id == null) return false;
  const self = bot.selfId || event.self_id;
  const sender = String(event.user_id);
  const group = bot.state.group(event.group_id);
  const excluded = [self, ...(config.suggestionReview?.excludedUserIds || []), ...(config.botIds || []), config.control?.gameBotId, group?.gameBotId].filter(Boolean).map(String);
  if (excluded.includes(sender) || !mention(event, self)) return false;
  if (config.groups?.length && !config.groups.map(String).includes(String(event.group_id))) return false;
  const text = textOf(event);
  return !(config.behavior?.prefix || ['#宽松']).some(p => text.startsWith(p));
}
function validate(result) {
  if (!result || !['valid', 'invalid', 'unrelated'].includes(result.status) || typeof result.reason !== 'string' || !result.reason.trim()) throw new Error('Invalid reviewer result');
  if (result.status === 'valid' && (typeof result.suggestion !== 'string' || !result.suggestion.trim())) throw new Error('Missing actionable suggestion');
  return result;
}
class SuggestionReview {
  constructor({bot, config, send, logger, review}) {
    this.bot = bot; this.config = config; this.send = send; this.logger = logger;
    this.data = path.dirname(config.paths.state);
    this.root = path.join(this.data, 'suggestions');
    this.settings = config.suggestionReview || {};
    this.review = review || (async input => {
      const token = (await fs.readFile(this.settings.tokenFile, 'utf8')).trim();
      const response = await fetch(this.settings.url || 'http://127.0.0.1:3082/review', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body: JSON.stringify(input), signal: AbortSignal.timeout(95000),
      });
      if (!response.ok) throw new Error(`DSH HTTP ${response.status}`);
      return response.json();
    });
    this.captureQueue = Promise.resolve(); this.running = false; this.closed = false;
    this.ready = Promise.all(['pending', 'accepted', 'audit'].map(sub => fs.mkdir(path.join(this.root, sub), {recursive: true, mode: 0o700})));
  }
  async start() {
    await this.ready;
    this.timer = setInterval(() => this.drain().catch(e => this.logger(`建议审核: ${e.message}`)), 30000);
    this.timer.unref();
    await this.drain();
  }
  accept(event) {
    if (this.closed || !eligible(event, this.bot, this.config)) return;
    // Capture outside the game queue; model/network work never blocks game decisions.
    const snapshot = JSON.parse(JSON.stringify(this.bot.state.group(event.group_id) || {}));
    this.captureQueue = this.captureQueue.then(() => this.capture(event, snapshot)).catch(e => this.logger(`建议保存失败: ${e.message}`));
  }
  async write(file, value) {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), {mode: 0o600});
    await fs.rename(tmp, file);
  }
  async capture(event, state) {
    await this.ready;
    const id = crypto.createHash('sha256').update(`${event.group_id}:${event.message_id}`).digest('hex').slice(0, 24);
    const file = path.join(this.root, 'pending', id + '.json');
    for (const sub of ['pending', 'accepted', 'audit']) {
      try { await fs.access(path.join(this.root, sub, id + '.json')); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const record = {version: 1, id, receivedAt: new Date((event.time || Date.now()/1000)*1000).toISOString(), capturedAt: new Date().toISOString(), groupId: String(event.group_id), userId: String(event.user_id), messageId: event.message_id, sender: event.sender?.card || event.sender?.nickname || '', text: textOf(event), attachments: (event.message || []).filter?.(p => p.type === 'image').map(p => ({type:p.type, file:p.data?.file})) || [], state, attempts: 0};
    record.context = {};
    const read = async (name, target, limit) => {
      try {
        const stat = await fs.stat(target);
        if (stat.size > limit) { record.context[name + 'Unavailable'] = 'size limit'; return; }
        record.context[name] = await fs.readFile(target, 'utf8');
      } catch (e) {record.context[name + 'Unavailable'] = e.code || 'read failed';}
    };
    if (/^[\w-]{1,64}$/.test(state.session || '')) await read('journal', path.join(this.data, 'sessions', state.session + '.json'), 2e6);
    await read('rules', this.settings.rulesFile || path.join(__dirname, '../suggestion-review/rules.txt'), 200000);
    record.rulesSha256 = crypto.createHash('sha256').update(record.context.rules || '').digest('hex');
    try {
      const lines = (await fs.readFile(path.join(this.data, 'messages.jsonl'), 'utf8')).trim().split('\n');
      record.context.recentMessages = lines.slice(-2000).flatMap(line => {try {const r = JSON.parse(line); return String(r.groupId) === record.groupId ? [r] : [];} catch {return [];}}).slice(-50);
    } catch {record.context.recentMessages = [];}
    await this.write(file, record);
    void this.drain().catch(e => this.logger(`建议审核: ${e.message}`));
  }
  input(record) {
    let journal = null;
    try {journal = JSON.parse(record.context.journal);} catch {}
    return {suggestion: record.text.slice(0, 12000), attachmentsNotReviewed: record.attachments.length > 0, receivedAt: record.receivedAt, capturedAt: record.capturedAt, rules: record.context.rules || '', state: record.state, journal: journal && {base: journal.base, meta: journal.meta, messages: journal.messages?.slice(-100), totalMessages: journal.messages?.length, truncated: journal.messages?.length > 100}, recentMessages: record.context.recentMessages, contextLimitations: Object.keys(record.context).filter(k => k.endsWith('Unavailable'))};
  }
  async reply(record, kind) {
    // Full internal reasoning may contain private clues; publish only the
    // separately requested public explanation, never the context or reason.
    const reason = kind === 'invalid' ? String(record.verdict?.publicReason || '建议尚未满足规则一致性或可执行性要求，请补充具体问题和改进办法。')
      .replace(/\[CQ:[^\]]*\]/gi, '').replace(/[\r\n\t\x00-\x1f]/g, ' ').replace(/@/g, '＠').slice(0, 180) : '';
    await this.send({type: 'group', groupId: record.groupId, message: [{type:'reply',data:{id:String(record.messageId)}}, {type:'at',data:{qq:record.userId}}, {type:'text',data:{text:' ' + TEMPLATES[kind] + (reason ? '\n原因：' + reason : '')}}]});
  }
  async drain() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      const files = (await fs.readdir(path.join(this.root, 'pending'))).filter(f => f.endsWith('.json')).sort();
      for (const name of files) {
        if (this.closed) break;
        const file = path.join(this.root, 'pending', name);
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        if (record.nextAttempt && Date.parse(record.nextAttempt) > Date.now()) continue;
        try {
          if (!record.verdict) {
            record.attempts++;
            record.verdict = validate(await this.review(this.input(record)));
            record.reviewedAt = new Date().toISOString();
            await this.write(file, record);
          }
          // Accepted copy is durable BEFORE acknowledging to the sender.
          const target = path.join(this.root, record.verdict.status === 'valid' ? 'accepted' : 'audit', name);
          await this.write(target, record);
          if (!record.repliedAt) {
            await this.reply(record, record.verdict.status);
            record.repliedAt = new Date().toISOString();
            await this.write(file, record);
            await this.write(target, record);
          }
          await fs.unlink(file);
        } catch (e) {
          record.lastError = e.message;
          record.nextAttempt = new Date(Date.now() + Math.min(3600000, 60000 * 2**Math.min(record.attempts, 6))).toISOString();
          await this.write(file, record);
          if (!record.pendingNotified) {
            try {await this.reply(record, 'pending'); record.pendingNotified = true; await this.write(file, record);} catch {}
          }
          this.logger(`建议 ${record.id} 待重试: ${e.message}`);
        }
      }
    } finally { this.running = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
module.exports = {SuggestionReview, eligible, mention, validate, TEMPLATES};
