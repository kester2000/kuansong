'use strict';
/**
 * part1 brain: decide which QQ messages are 长夜 material, keep one session per
 * group, feed part2, and answer with part2's suggestion.
 *
 * Transport-agnostic: everything it needs is the OneBot-shaped event plus a
 * `send` function, which is what makes the mock end-to-end test possible.
 */
const fs = require('node:fs');
const path = require('node:path');

const kernel = require('../night-strategist/kernel.cjs');
const store = require('../night-strategist/store.cjs');
const { groupAllowed } = require('../host.cjs').get('config.cjs');
const { saveImageData } = require('../host.cjs').get('images.cjs');
const inbox = require('../host.cjs').get('inbox.cjs');
const artifact = require('../host.cjs').get('artifact.cjs');
const matches = require('../host.cjs').get('matches.cjs');
const supportedGames = require('./supported-games.cjs');
const decisionPolicy = require('./decision.cjs');

const NEW_GAME = /本局游戏人数为\s*(\d+)\s*人[，,]\s*逃生舱数量为\s*(\d+)\s*个/;
const DISMISSED_GAME = /(?:游戏|房间)已解散|所有玩家都强制退出了游戏.*游戏解散|全员支持中断游戏，游戏已中断/s;
const END_GAME = /游戏结束|回合数到达上限|(?:游戏|房间)已解散|所有玩家都强制退出了游戏.*游戏解散|全员支持中断游戏，游戏已中断/s;
const MODE_FROM_BROADCAST = /【区块模式】\s*(经典|幻变|狂野|疯狂|按钮|陷阱|空旷|无声)/;
const PLAYER_LINE = /^\s*\[(\d+)号\](.*)$/gm;

const {StateStore}=require('../host.cjs').get('state.cjs');

class LongNightBot {
  constructor({ config, part2, state, send, logger, history, privateHistory, policy = null }) {
    this.config = config;
    this.part2 = part2;
    this.policy = policy;
    this.state = state;
    this.send = send; // async (target, message) => void
    this.log = logger || console.log;
    this.selfId = config.onebot.selfId ? String(config.onebot.selfId) : null;
    this.selfNames = new Set();
    this.timers = new Map();
    this.analysisTimers = new Map();
    this.inflight = new Map();
    this.pending = new Map();
    this.turns = new Map();
    this.inferTimes = new Map();
    this.lastSend = new Map();
    this.stats = { seen: 0, relevant: 0, appended: 0, inferred: 0, replied: 0, errors: 0, images: 0 };
    this.recent = [];
    this.queue = Promise.resolve();
    this.replayedEventIds = new Set();
    this.pendingOpeningImage = new Map();
    this.history = history || null;
    this.privateHistory = privateHistory || null;
    this.controlHits = new Map();
    this.gameInfoPending = null;
  }

  isOwnReminder(event, text) {
    if (!/以下玩家还未选择/.test(text) || !Array.isArray(event.message)) return false;
    return event.message.some(segment => {
      if (segment.type === 'at') return String(segment.data?.qq) === String(this.selfId);
      if (segment.type !== 'markdown') return false;
      return [...String(segment.data?.content).matchAll(/mqqapi:\/\/markdown\/mention\?([^)]*)\)/g)]
        .some(match => new URLSearchParams(match[1]).get('at_tinyid') === String(this.selfId));
    });
  }

  recoveryPrompt(messages, botId) {
    let candidate = null, rejectedCandidate = null,lastOwnPrompt=null;
    for (const event of messages) {
      if (String(event.user_id) === String(this.selfId)) {
        const command=this.textOf(event).replace(/^@\d+\s*/, '').trim();
        if (/^(?:[上下左右UDLRsxzy]+|停止)$/.test(command)) { rejectedCandidate = candidate; candidate = null; }
        continue;
      }
      if (String(event.user_id) !== String(botId)) continue;
      const text = this.textOf(event), turn = this.detectTurnPrompt(event, text);
      if (/\[错误\]\s*解析失败/.test(text) && event.message?.some(s=>s.type==='at'&&String(s.data?.qq)===String(this.selfId))) {
        candidate = rejectedCandidate ?? candidate; rejectedCandidate = null; continue;
      }
      rejectedCandidate = null;
      if(this.isOwnReminder(event,text)&&lastOwnPrompt)candidate={...lastOwnPrompt,reminderTime:Number(event.time)*1000};
      if (END_GAME.test(text) || NEW_GAME.test(text) || /【当前阶段】|完整行动轨迹/.test(text)) candidate = null;
      if (turn) candidate = turn.ours && turn.kind !== 'end' && (turn.kind!=='continue'||/请继续行动/.test(text)) ? {event, text, turn} : null;
      if(turn||END_GAME.test(text)||NEW_GAME.test(text)||/完整行动轨迹|【当前阶段】/.test(text))lastOwnPrompt=candidate;
    }
    return candidate;
  }

  async recoverMissedOpenings() {
    if (!this.history) return;
    this.recovering = true;
    const resumes = [];
    let complete=true;
    try {
      for (const [groupId, original] of Object.entries(this.state.data.groups || {})) {
       try {
        this.cancelTimers(`g${groupId}`);
        this.turns.delete(groupId);
        let messages = (await this.history(groupId,100)).slice().sort((a,b)=>Number(a.time)-Number(b.time));
        const botId = String(original.gameBotId || this.config.control?.gameBotId || this.config.botIds?.[0] || '');
        const anchored=rows=>rows.some(m=>Number(m.time)*1000>=Date.parse(original.startedAt||0)&&String(m.user_id)===botId&&(NEW_GAME.test(this.textOf(m))||/【当前阶段】/.test(this.textOf(m))));
        if(!original.ended&&!anchored(messages))for(const count of [500,1000]){
          const expanded=await this.history(groupId,count);
          const unique=new Map(messages.map(m=>[String(m.message_id),m]));
          for(const m of expanded)unique.set(String(m.message_id),m);
          messages=[...unique.values()].sort((a,b)=>Number(a.time)-Number(b.time));
          if(anchored(messages))break;
        }
        const opening = messages.filter(m=>String(m.user_id)===botId&&NEW_GAME.test(this.textOf(m))).at(-1);
        const known = original.startedAt;
        const isNew = opening && String(original.openingMessageId)!==String(opening.message_id) && (!known || Number(opening.time)*1000>Date.parse(known));
        if (isNew) await this.onBotMessage({event:opening,text:this.textOf(opening),groupId});
        const group = this.state.group(groupId);
        if (!group?.session || group.ended || !group.startedAt) continue;
        const since = Date.parse(group.startedAt);
        const currentMessages = messages.filter(m=>Number(m.time)*1000>=since);
        // A bounded history with no opening/stage cannot establish round labels.
        if (!currentMessages.some(m=>String(m.user_id)===botId && (NEW_GAME.test(this.textOf(m)) || /【当前阶段】/.test(this.textOf(m))))) {
          complete=false;this.log('历史范围不足以确认回合，将自动重试恢复：'+groupId); continue;
        }
        const privates = this.privateHistory ? await this.privateHistory(botId,100) : [];
        const timeline = [...currentMessages.map(event=>({event,private:false})), ...privates.filter(m=>Number(m.time)*1000>=since-2000).map(event=>({event,private:true}))].sort((a,b)=>Number(a.event.time)-Number(b.event.time));
        const firstStage=timeline.findIndex(row=>!row.private&&/【当前阶段】\s*主阶段\s*>>\s*第\s*(\d+)\s*回合/.test(this.textOf(row.event)));
        const firstStageRound=firstStage>=0?Number(this.textOf(timeline[firstStage].event).match(/主阶段\s*>>\s*第\s*(\d+)\s*回合/)[1]):1;
        // A bounded history may start BEFORE its first visible stage header.
        // Never initialize that prefix with the persisted latest round.
        const initialRound=opening&&Number(opening.time)*1000>=since?1:Math.max(1,firstStageRound-(firstStage>0?1:0));
        this.state.setGroup(groupId,{currentRound:initialRound,routeRounds:{},playerUsers:{}});
        for (const row of timeline) {
          const event=row.event;
          if (!row.private && String(event.user_id)!==botId) continue;
          const text=this.textOf(event);
          if (NEW_GAME.test(text)) continue;
          if(!row.private)this.learnGameBot(groupId,event,text);
          const stage=!row.private&&text.match(/【当前阶段】\s*主阶段\s*>>\s*第\s*(\d+)\s*回合/);
          if(stage){this.state.setGroup(groupId,{currentRound:Number(stage[1])});continue;}
          const sourceKey=`${row.private?'private':'group'}:${event.message_id}`;
          const existing=event.message_id!=null&&store.load(group.session)?.messages?.some(m=>m.source?.key===sourceKey);
          if(existing&&!END_GAME.test(text)&&!this.detectTurnPrompt(event,text))continue;
          if (row.private) {
            const parsed=this.inspect(text);
            const recorded=store.load(group.session)?.messages?.some(m=>m.view===group.self&&m.text===text);
            const stamped=/【开局】|【第\s*\d+\s*回合】/.test(text) ? text : `【第 ${this.state.group(groupId).currentRound} 回合】\n${text}`;
            if(parsed.relevant&&!recorded)this.queuePrivate({event,text:stamped,parsed},groupId);
            continue;
          }
          const turn=this.detectTurnPrompt(event,text);
          this.learnPromptPlayer(groupId,event,text,turn);
          const recordedText=this.publicFirstSoundClue(groupId,event,text);
          await this.guessSelf(group.session,groupId,recordedText);
          const parsed=this.inspect(recordedText);
          if(parsed.relevant || END_GAME.test(recordedText)) await this.appendToSession({groupId,text:recordedText,event,parsed});
          if(turn?.ours) await this.handleTurn({event,text,groupId,turn});
          if(END_GAME.test(text))await this.onGameEnd({groupId,event});
        }
        await this.flushPrivate(groupId);
        for (const row of timeline) if(row.event.message_id != null) this.replayedEventIds.add(`${row.private?'private':'group'}:${row.event.message_id}`);
        while(this.replayedEventIds.size>500)this.replayedEventIds.delete(this.replayedEventIds.values().next().value);
        this.state.save();
        const latest=this.recoveryPrompt(currentMessages,botId);
        if(original.uncertainPromptId&&String(latest?.event.message_id)===String(original.uncertainPromptId)
          &&(!latest.reminderTime||!original.actionAttemptAt||latest.reminderTime>original.actionAttemptAt)){
          this.state.setGroup(groupId,{lastActionPromptId:null,uncertainPromptId:null,pendingBatch:null});
          group.lastActionPromptId=null;
          this.state.save();
        }
        else if(original.uncertainPromptId){
          const attempt=currentMessages.findIndex(m=>String(m.message_id)===String(original.uncertainPromptId));
          const resolved=attempt>=0&&currentMessages.slice(attempt+1).some(m=>String(m.user_id)===botId&&(/完整行动轨迹|在公屏选择方向移动|请继续行动/.test(this.textOf(m))));
          if(resolved){this.state.setGroup(groupId,{uncertainPromptId:null});this.state.save();}
          else complete=false;
        }
        const current=this.turns.get(groupId);
        if(latest?.reminderTime>original.actionAttemptAt&&String(latest.event.message_id)===String(original.lastActionPromptId)){
          this.state.setGroup(groupId,{lastActionPromptId:null,pendingBatch:null});
          group.lastActionPromptId=null;
          this.state.save();
        }
        const step = latest?.text.match(/\[第\s*(\d+)\s*步\]/);
        const completeSteps = latest?.turn.kind !== 'continue' || (step && current?.steps.length===Number(step[1]));
        const pendingBatch=this.state.group(groupId).pendingBatch;
        const batchRunning=pendingBatch&&current?.round===pendingBatch.round&&current.steps.length<pendingBatch.endStep&&!this.state.group(groupId).ended;
        if(batchRunning){this.state.setGroup(groupId,{pendingBatch});this.state.save();current.sent=true;}
        if(!batchRunning&&latest?.event.message_id != null && current && completeSteps && !this.state.group(groupId).ended && String(group.lastActionPromptId)!==String(latest.event.message_id)) {
          current.promptId=String(latest.event.message_id);
          current.recovered=true;
          resumes.push({groupId,event:latest.event});
        } else if(!batchRunning)this.turns.delete(groupId);
        this.log('已回填当前局群聊与私聊：'+groupId);
       }catch(error){complete=false;this.log(`恢复失败，将自动重试 ${groupId}: ${error.message}`);}
      }
    } finally { this.recovering=false; }
    for(const context of resumes) if(this.config.behavior.mode==='auto') this.scheduleInfer(`g${context.groupId}`,context,400);
    // Backfilled opponent routes also change the board while we are waiting.
    for(const [groupId,group] of Object.entries(this.state.data.groups||{})){
      if(!group.session||group.ended||this.turns.has(String(groupId)))continue;
      const journal=store.load(group.session);
      const board=artifact.load(group.session);
      if(journal&&board?.report?.progress?.messages!==journal.messages.length)
        this.runInfer({groupId,event:null,auto:false}).catch(error=>this.log(error.message));
    }
    return complete;
  }

  /** Board backfill: build missing artifacts, then fill a missing pool or the
   *  private messages (own walls / sounds) a restart may have lost. */
  async backfillArtifacts() {
    try {
      for (const row of store.list()) {
        if (!row || row.broken) continue;
        const journal = store.load(row.id);
        if (!journal) continue;
        const groupId = String(row.id).replace(/^g/, '');
        const group = this.state.group(groupId) || {};
        const cfg = (journal.base && journal.base.config) || {};
        let data = artifact.load(row.id);

        if (!data) {
          artifact.setSettings(row.id, {
            mode: cfg.mode || null,
            modeName: kernel.MODE_NAMES[cfg.mode] || cfg.mode || null,
            players: (journal.base.players || []).length || null,
            size: cfg.size || null,
            exitCount: cfg.exitCount == null ? null : cfg.exitCount,
            group: (journal.meta || {}).group || groupId,
          });
          for (const message of journal.messages) {
            let parsed;
            try { parsed = kernel.M.inspect(message.text); } catch { parsed = { type: '附注', privateInput: false }; }
            artifact.addMessage(row.id, {
              id: message.id,
              view: message.view,
              type: parsed.type,
              text: message.text,
              private: !!parsed.privateInput,
            });
          }
          data = artifact.load(row.id);
        }

        if (!data.pool) {
          if (cfg.pool) {
            artifact.setPool(row.id, { ids: cfg.pool.split(/\s+/).filter(Boolean), confidence: 'manual', source: 'journal' });
          } else if (group.openingImage && fs.existsSync(group.openingImage)) {
            try {
              const result = await this.part2.poolRead({ image: group.openingImage, mode: cfg.mode, session: row.id });
              if (result && result.ok && result.confidence !== 'low') {
                artifact.setPool(row.id, { ids: result.ids, confidence: result.confidence, texture: result.texture, image: group.openingImage, tiles: result.tiles });
                this.log('回填区块池：' + result.pool);
              }
            } catch (error) {
              this.log('回填区块池失败: ' + error.message);
            }
          }
        }

        const hasPrivateInJournal = journal.messages.some((message) => /【开局】|完整赛况/.test(String(message.text || '')));
        if (!hasPrivateInJournal && this.privateHistory && group.self != null && group.startedAt) {
          const botId = group.gameBotId || (this.config.control || {}).gameBotId || (this.config.botIds || [])[0];
          if (botId) {
            try {
              const privates = (await this.privateHistory(botId, 60)).filter(m => Number(m.time) * 1000 >= Date.parse(group.startedAt) - 2000);
              const view = group.self == null ? 0 : Number(group.self);
              const bodies = privates.map((message) => this.textOf(message));
              // Several games may share the DM history: only the newest 【开局】
              // and what follows it belong to the current one.
              let from = -1;
              for (let i = 0; i < bodies.length; i++) if (/【开局】/.test(bodies[i])) from = i;
              let added = 0;
              for (const body of (from >= 0 ? bodies.slice(from) : bodies)) {
                if (!/【开局】|完整赛况|你听见了|声响|隐匿/.test(body)) continue;
                await this.part2.append({ session: row.id, text: body, view });
                artifact.addMessage(row.id, { type: '私聊补录', text: body, private: true });
                added++;
              }
              if (added) this.log('补录私聊 ' + row.id + ' ' + added + ' 条');
            } catch (error) {
              this.log('补录私聊失败: ' + error.message);
            }
          }
        }
      }
    } catch (error) {
      this.log('回填看板失败: ' + error.message);
    }
  }

  /* ------------------------------ transport ------------------------------ */

  /**
   * Events are handled strictly one at a time: the opening broadcast creates
   * the session asynchronously, and the private walls that follow a moment
   * later must not race ahead of it.
   */
  onEvent(event) {
    this.tryResolveGameInfo(event);
    const task = this.queue
      .then(async () => {
        if(event?.message_id != null && this.replayedEventIds.has(`${event.message_type}:${event.message_id}`)) return;
        this.trace = this.startTrace(event);
        try {
          await this.handleEvent(event);
        } finally {
          this.finishTrace();
        }
      });
    this.queue = task.catch((error) => {
        this.stats.errors += 1;
        this.log(`处理事件失败: ${error.stack || error.message}`);
      });
    return task;
  }

  /** One row per received message, rendered on the dashboard. */
  startTrace(event) {
    if (!event || event.post_type !== 'message') return null;
    const text = this.textOf(event);
    const images = this.imagesOf(event);
    const sender = (event.sender && (event.sender.card || event.sender.nickname)) || '';
    return {
      at: new Date().toISOString(),
      kind: event.message_type,
      groupId: event.group_id ? String(event.group_id) : null,
      userId: event.user_id ? String(event.user_id) : null,
      name: sender,
      text: String(text || (images.length ? '[图片×' + images.length + ']' : '')).slice(0, 400),
      type: '',
      relevant: false,
      action: 'ignored',
      images: images.length,
    };
  }

  note(patch) {
    if (this.trace) Object.assign(this.trace, patch);
  }

  finishTrace() {
    const trace = this.trace;
    this.trace = null;
    if (trace) inbox.append(trace);
  }

  async handleEvent(event) {
    if (!event || event.post_type !== 'message') return;
    if (!this.selfId && event.self_id) this.selfId = String(event.self_id);
    this.stats.seen += 1;
    const text = this.textOf(event);
    const groupId = event.message_type === 'group' ? String(event.group_id) : null;
    if (groupId && !groupAllowed(this.config, groupId)) return;
    const userId = String(event.user_id || '');
    if (userId === this.selfId) {
      this.recordSelfName(event);
      // The bot runs on the player's own QQ, so the player's commands arrive as
      // "self" messages. Only a command prefix is acted on, which also keeps our
      // own replies (they start with 【长夜) from looping back in.
      if (groupId) await this.onHumanMessage({ event, text, groupId, userId });
      return;
    }
    // The game bot announces its own command prefix ("通过「/加入」报名"); learn
    // who it is and which prefix it uses before any game material arrives.
    if (groupId && text) this.learnFromAnnouncement(groupId, event, text);

    if (!text.trim() && !this.imagesOf(event).length) return;


    if (this.isBot(event)) {
      await this.onBotMessage({ event, text, groupId });
      return;
    }
    if (groupId) await this.onHumanMessage({ event, text, groupId, userId });
  }

  textOf(event) {
    if (typeof event.message === 'string') return normalize(event.message);
    if (!Array.isArray(event.message)) return '';
    const markdown = event.message.filter((segment) => segment && segment.type === 'markdown').map((segment) => markdownText(segment.data && segment.data.content)).join('\n').trim();
    if (markdown) return normalize(markdown);
    return normalize(event.message.map((segment) => {
      if (!segment || !segment.type) return '';
      if (segment.type === 'text') return segment.data && segment.data.text || '';
      if (segment.type === 'at') return `@${segment.data && segment.data.qq} `;
      if (segment.type === 'image') return '[图片]';
      return '';
    }).join(''));
  }

  /** Image payloads of a message: plain image segments plus markdown-embedded URLs. */
  imagesOf(event) {
    const out = [];
    const segments = Array.isArray(event && event.message) ? event.message : [];
    for (const segment of segments) {
      if (!segment || !segment.type) continue;
      if (segment.type === 'image') {
        const data = segment.data || {};
        if (data.url || data.file) out.push({ url: data.url, file: data.file });
      }
      if (segment.type === 'markdown') out.push(...markdownImages(segment.data && segment.data.content));
    }
    return out;
  }

  /** Save the bot's pictures under data/images/ and remember the opening one. */
  async captureImages(event, groupId, text) {
    // A dismissed match has no delayed score/map package. Do not let the next
    // game's pictures refresh its archive, including after a process restart.
    if (groupId && this.state.group(groupId)?.archiveClosed && !NEW_GAME.test(String(text || ''))) return [];
    const saved = await saveImageData(this.imagesOf(event), event, { logger: this.log });
    if (!saved.length) return [];
    this.stats.images = (this.stats.images || 0) + saved.length;
    this.note({ images: saved.length });
    const group = groupId ? this.state.group(groupId) : null;
    if (group && group.session) {
      const patch = { lastImage: saved[0] };
      if (NEW_GAME.test(String(text || ''))) patch.openingImage = saved[0];
      this.state.setGroup(groupId, patch);
      this.state.save();
      if (!NEW_GAME.test(String(text || ''))) {
        const board = artifact.load(group.session) || {};
        const images = [...(board.images || [])];
        for (const file of saved) if (!images.some(i => i.file === file)) images.push({file, at:new Date().toISOString(), messageId:event.message_id || null, caption:text || '机器人图片', phase:group.ended || END_GAME.test(text) ? '赛后' : '对局中'});
        artifact.save(group.session,{...board,images});
        if (group.ended) matches.save(group.session,{refresh:true});
      }
    } else if (groupId && NEW_GAME.test(String(text || ''))) {
      // The opening broadcast carries the image before the session exists.
      this.pendingOpeningImage.set(String(groupId), saved[0]);
    }
    this.log(`已保存机器人图片 ${saved.length} 张 → ${saved[0]}`);
    return saved;
  }

  isBot(event) {
    const userId = String(event.user_id || '');
    if (this.config.botIds.includes(userId)) return true;
    if (event.group_id && String(this.state.group(event.group_id)?.gameBotId || '') === userId) return true;
    // Any sender whose text parses as game material counts too; other groups
    // host other LGTBot instances, so this keeps recognition working there.
    // when they parse as game material, which a human rarely produces by accident.
    const text = this.textOf(event);
    if (this.isRelevant(text)) return true;
    // Turn prompts and per-step results carry no parseable item, but they are game material.
    if (/在公屏选择方向移动|请继续行动|本回合结束/.test(text)) return true;
    // "游戏结束" carries no parseable item, so recognise it only inside a live
    // game (otherwise any chat about the game would end it).
    if (END_GAME.test(text)) {
      const groupId = event.message_type === 'group' ? String(event.group_id) : this.state.data.lastGroup;
      const group = groupId ? this.state.group(groupId) : null;
      return !!(group && group.session && !group.ended);
    }
    return false;
  }

  inspect(text) {    try {
      const parsed = kernel.M.inspect(text);
      const relevant = (parsed.type !== '附注' || parsed.counts.status || parsed.counts.personalSound) && Object.keys(parsed.counts).length > 0;
      return { relevant, type: parsed.type, counts: parsed.counts, privateInput: !!parsed.privateInput };
    } catch (error) {
      this.log(`解析失败: ${error.message}`);
      return { relevant: false, type: 'error', counts: {} };
    }
  }

  isRelevant(text) {
    return this.inspect(text).relevant;
  }

  /* ------------------------------ bot output ----------------------------- */

  async onBotMessage({ event, text, groupId }) {
    // Lobby dissolution has no game trajectory and may follow a finished
    // session. Release its reservation before the ordinary relevance filter.
    const reserved=this.state.group(groupId);
    const trustedArchiveSender=this.config.botIds.includes(String(event.user_id))||String(reserved?.gameBotId||'')===String(event.user_id);
    if(reserved?.ended&&trustedArchiveSender&&/游戏名称\s*[：:]/.test(text)){
      // The next lobby, even another long-night lobby, closes the previous
      // game's late-image window. Its real opening resets archiveClosed.
      this.state.setGroup(groupId,{archiveClosed:true});this.state.save();
    }
    if(groupId&&reserved?.joinReserved&&reserved.joinKind==='solo'&&!reserved.joinConfirmed
      &&String(reserved.gameBotId)===String(event.user_id)&&/\[错误\].*(?:建立失败|创建失败)/s.test(text)){
      this.state.setGroup(groupId,{joinReserved:false,joinSettings:null,joinKind:null,soloToken:null,soloPendingVerification:false,joinFailure:text,ended:true});
      this.state.save();return;
    }
    const joinReplyTargets=Array.isArray(event.message)
      ? event.message.filter(segment=>segment?.type==='at'&&String(segment.data?.qq)!=='0') : [];
    if(groupId&&reserved?.joinReserved&&!reserved.joinConfirmed&&(!reserved.session||reserved.ended)
      &&String(reserved.gameBotId)===String(event.user_id)
      &&(!joinReplyTargets.length||joinReplyTargets.some(segment=>String(segment.data?.qq)===String(this.selfId)))
      &&/加入失败|报名失败|无法加入|不能加入|人数已满|游戏已经开始|游戏已开始/.test(text)){
      this.state.setGroup(groupId,{joinReserved:false,joinSettings:null,joinFailure:text,ended:true});
      this.state.save();
      return;
    }
    const tutorialEnded=this.state.group(groupId)?.joinSettings?.roomRules?.教程==='开启'&&/【教程完成】|教程已结束/.test(text);
    if(groupId&&(DISMISSED_GAME.test(text)||tutorialEnded)){
      const group=this.state.group(groupId)||{};
      const trusted=String(group.gameBotId||'')===String(event.user_id)
        ||this.config.botIds.includes(String(event.user_id));
      if(!trusted)return;
      this.note({action:'game-dismissed',relevant:true});
      this.turns.delete(String(groupId));this.cancelTimers(`g${groupId}`);
      this.pending.delete(`g${groupId}`);
      if(group.session&&!group.ended){
        await this.appendToSession({groupId,text,event,parsed:this.inspect(text)});
        this.state.setGroup(groupId,{archiveClosed:true});this.state.save();
        await this.onGameEnd({groupId,event});
      }else{
        // Do not append a new lobby's dismissal to the previous match archive.
        this.state.setGroup(groupId,{joinReserved:false,joinSettings:null,joinKind:null,soloToken:null,soloPendingVerification:false,ended:true,archiveClosed:true,lastDismissedAt:new Date().toISOString()});
        this.state.save();
      }
      return;
    }
    if(reserved?.ended&&this.state.group(groupId)?.archiveClosed&&!NEW_GAME.test(text))return;
    text = String(text).replace(/玩家\s*@([0-7])号[：:]\[[^\]\n]*\]\s*退出游戏/g, '玩家 [$1号] 退出游戏');
    if (groupId && this.state.group(groupId)?.session && !NEW_GAME.test(text)) {
      await this.guessSelf(`g${groupId}`, groupId, text);
    }
    // Stage announcements carry the round for *all* players, including identical
    // routes in different rounds. Keep them before the relevance filter.
    const stage = String(text).match(/【当前阶段】\s*主阶段\s*>>\s*第\s*(\d+)\s*回合/);
    if (stage && groupId && this.state.group(groupId)?.session) {
      this.state.setGroup(groupId, { currentRound: Number(stage[1]) });
      this.state.save();
      return;
    }
    const ended = END_GAME.test(text);
    const turnPrompt = this.detectTurnPrompt(event, text);
    this.learnPromptPlayer(groupId,event,text,turnPrompt);
    const recordedText=this.publicFirstSoundClue(groupId,event,text);
    const parsed = this.inspect(recordedText);
    if(groupId&&String(event.user_id)===String(this.state.group(groupId)?.gameBotId)&&this.isOwnReminder(event,text)){
      this.recoveryRequested=true;
      this.wakeRecovery?.();
    }
    // Image-only and delayed post-game messages must survive the text parser.
    let imageGroup = groupId;
    if (!imageGroup && this.imagesOf(event).length) {
      const candidates = Object.entries(this.state.data.groups || {}).filter(([,g]) => g.session && String(g.gameBotId || '') === String(event.user_id));
      if (candidates.length === 1) imageGroup = candidates[0][0];
    }
    const imageSession = imageGroup && this.state.group(imageGroup);
    const trusted = this.config.botIds.includes(String(event.user_id)) || String(imageSession?.gameBotId || '') === String(event.user_id);
    const gameImage = trusted && imageSession?.session && this.imagesOf(event).length;
    if (!parsed.relevant && !ended && !gameImage && !(turnPrompt && turnPrompt.ours)) return;
    this.stats.relevant += 1;
    this.note({ relevant: true, type: parsed.type });
    // Only game material is kept as a picture: the group also has memes, and
    // downloading every one of them would be pointless.
    if (this.imagesOf(event).length) {
      await this.captureImages(event, imageGroup, text).catch((error) => this.log(`图片处理失败: ${error.message}`));
    }
    if (groupId) this.learnGameBot(groupId, event, text);
    if (groupId) {
      const start = text.match(NEW_GAME);
      if (start) await this.startGame({ groupId, event, text, players: Number(start[1]), exits: Number(start[2]) });
      await this.appendToSession({ groupId, text:recordedText, event, parsed });
      if (END_GAME.test(text)) {
        this.note({ action: 'game-end' });
        await this.onGameEnd({ groupId, event });
        return;
      }
      if (this.state.group(groupId)?.ended) { matches.save(`g${groupId}`, {refresh:true}); return; }
      // It is our turn: the game bot posts "请 [0号：@我们] 在公屏选择方向移动".
      // Answer right there instead of waiting for a trajectory nobody wrote yet.
      if (turnPrompt && (turnPrompt.ours || turnPrompt.kind === 'end')) {
        if (turnPrompt.ours) this.note({ action: 'our-turn' });
        await this.handleTurn({ event, text, groupId, turn: turnPrompt });
      }
      return;
    }
    // Private message from the bot (walls, sounds, 完整赛况, 地狱 whispers).
    const sender = String(event.user_id);
    const possible = Object.entries(this.state.data.groups || {}).filter(([,g]) => !g.ended && g.session && String(g.gameBotId || '') === sender);
    const selected = possible.length === 1 ? possible[0] : null;
    const opening = /【开局】/.test(text);
    const fresh = selected && selected[1].startedAt && Date.now()-Date.parse(selected[1].startedAt)<120000;
    if (!selected || selected[1].self == null || (opening && !fresh)) {
      this.queuePrivate({event,text,parsed}, selected && (!opening || fresh) ? selected[0] : null);
      return;
    }
    if(event.time && Number(event.time)*1000 < Date.parse(selected[1].startedAt)-2000)return;
    await this.flushPrivate(String(selected[0]));
    await this.appendToSession({groupId:selected[0],text,event,parsed,private:true});
  }

  queuePrivate({event,text,parsed}, groupId = null) {
    const pending = this.state.data.pendingPrivate ||= [];
    const sender = String(event.user_id);
    const key = String(event.message_id || sender + ':' + text);
    if (!pending.some(p=>p.key===key)) pending.push({key,messageId:event.message_id,sender,text,parsed,at:event.time ? Number(event.time)*1000 : Date.now(),groupId,startedAt:groupId?this.state.group(groupId)?.startedAt:null});
    this.state.save();
    this.note({action:'pending-private'});
    this.log('私聊已暂存，等待对局及本人编号确认');
  }

  async flushPrivate(groupId) {
    const group=this.state.group(groupId);
    if (!group?.session || group.self == null || group.ended || !group.startedAt) return;
    const candidates=Object.values(this.state.data.groups||{}).filter(g=>!g.ended&&g.session&&String(g.gameBotId)===String(group.gameBotId));
    const pending=this.state.data.pendingPrivate||[];
    for (const item of [...pending].sort((a,b)=>a.at-b.at)) {
      if(item.sender!==String(group.gameBotId))continue;
      const bound=item.groupId===String(groupId)&&item.startedAt===group.startedAt&&item.at>=Date.parse(group.startedAt)-2000;
      const early=!item.groupId&&candidates.length===1&&item.at>=Date.parse(group.startedAt)-2000&&item.at<Date.parse(group.startedAt)+120000;
      if(!bound&&!early)continue;
      const result=await this.part2.append({session:group.session,text:item.text,view:Number(group.self)});
      if(!result?.ok)continue;
      if(item.messageId!=null){
        const journal=store.load(group.session),record=journal?.messages.find(m=>m.id===result.id);
        if(record&&!record.source){record.source={key:'private:'+item.messageId,time:Math.floor(item.at/1000)};store.save(group.session,journal);}
      }
      if(!result.duplicate)artifact.addMessage(group.session,{id:result.id,view:Number(group.self),type:'私聊补录',text:item.text,private:true});
      this.state.data.pendingPrivate=this.state.data.pendingPrivate.filter(p=>p.key!==item.key);
      this.state.save();
    }
  }

  async startGame({ groupId, event, text, players, exits }) {
    this.turns.delete(String(groupId));
    this.cancelTimers(`g${groupId}`);
    const sessionId = `g${groupId}`;
    const previous = this.state.group(groupId);
    if(previous?.joinKind==='solo'&&players!==1){
      this.state.setGroup(groupId,{soloPendingVerification:true});this.state.save();
      this.log('请求单机但开局人数不是 1，暂停自动行动');
    }
    if (previous && previous.session) {
      matches.save(previous.session, { reason: previous.ended ? "game-over" : "next-game" });
      try { store.archive(previous.session); } catch (error) { this.log(`归档旧会话失败: ${error.message}`); }
    }
    const modeMatch = text.match(MODE_FROM_BROADCAST);
    const settings = { ...(previous?.joinReserved?previous.joinSettings:null), players, exitCount: exits, force: true, source: 'qq', group: groupId };
    if(players>6)settings.size=12;
    if(modeMatch)settings.mode=modeMatch[1];
    const announcedEvent=text.match(/\[特殊事件\]【([^】]+)】/)?.[1];
    if(announcedEvent)settings.event=require('./room-rules.cjs').events[announcedEvent]??settings.event;
    const self = null; // Player numbers are assigned anew every match.
    if (self != null) settings.self = self;
    let result;
    try {
      result = await this.part2.init({ session: sessionId, settings, meta: { group: groupId } });
    } catch (error) {
      this.stats.errors += 1;
      this.log(`开新局失败: ${error.message}`);
      return;
    }
    if (!result.ok) { this.log(`开新局失败: ${result.message}`); return; }
    // New match = clean board: the previous game's messages/pool/report must not
    // leak into the "本局消息" view.
    artifact.reset(sessionId);
    const openingImage = this.pendingOpeningImage.get(String(groupId)) || null;
    this.pendingOpeningImage.delete(String(groupId));
    const modeKey = settings.mode ? (kernel.MODE_KEYS[settings.mode] || String(settings.mode).toUpperCase()) : null;
    artifact.setSettings(sessionId, {
      mode: modeKey || settings.mode || null,
      modeName: settings.pool?'自定义':modeKey ? (kernel.MODE_NAMES[modeKey] || modeKey) : (settings.mode || null),
      roomRules:settings.roomRules, players, size: journalSize(sessionId), exitCount: exits, group: String(groupId),
    });
    this.state.setGroup(groupId, {
      session: sessionId,
      self: self == null ? null : Number(self),
      lastInferRound: null,
      lastActionPromptId: null,
      currentRound: 1,
      routeRounds: {},
      playerUsers: {},
      participation: null,
      ended: false,
      archiveClosed:false,
      endedAt:null,
      pendingBatch:null,
      heartbeatPaddingRound:null,
      coinSettlementRound:null,
      uncertainPromptId:null,
      joinSettings:null,
      ...(previous?.joinKind==='solo'?{joinKind:null,soloToken:null}:{}),
      startedAt: event?.time ? new Date(Number(event.time)*1000).toISOString() : new Date().toISOString(),
      openingMessageId: event?.message_id || null,
      ...(openingImage ? { openingImage } : {}),
    });
    this.state.data.lastSession = sessionId;
    this.state.data.lastGroup = String(groupId);
    this.state.save();
    artifact.setSettings(sessionId,{matchKey:require('./participation.cjs').matchKey(this.state.group(groupId)),participation:null});
    this.log(`新对局：群 ${groupId} / 会话 ${sessionId} / ${players} 人 / 逃生舱 ${exits}`);
    // Await it: the pool must be in place before the first round is appended and
    // before any command can ask for an inference.
    if (openingImage && !settings.pool) await this.maybeReadPool({ groupId, image: openingImage, mode: modeKey });
  }

  /**
   * The opening picture lists the drawn pool. For modes whose whole pool is used
   * (classic/open/silent) the pool is already exact, so only the random-subset
   * modes need the picture read.
   */
  async maybeReadPool({ groupId, image, mode }) {
    if (!this.config.poolImage.enabled || !image) return null;
    if (mode && kernel.autoPoolFor(mode)) return null;
    const sessionId = `g${groupId}`;
    try {
      const result = await this.part2.poolRead({ image, mode, session: sessionId });
      if (!result || !result.ok) {
        this.log(`读开局图失败：${(result && result.warnings && result.warnings.join('；')) || '未知原因'}`);
        return null;
      }
      artifact.setPool(sessionId, { ids: result.ids, confidence: result.confidence, texture: result.texture, image, tiles: result.tiles });
      this.state.setGroup(groupId, { imagePool: result.pool, imagePoolConfidence: result.confidence });
      this.state.save();
      this.log(`从开局图识别区块池（${result.confidence}）：${result.pool}`);
      if (result.warnings && result.warnings.length) this.log(`读图注意：${result.warnings.join('；')}`);
      if (this.config.poolImage.announce) {
        await this.reply({ groupId, event: null, text: `已从开局图识别区块池（${result.confidence}）：${result.pool}` });
      }
      return result;
    } catch (error) {
      this.stats.errors += 1;
      this.log(`读开局图出错：${error.message}`);
      return null;
    }
  }

  /** Try the saved opening picture first, then fall back to group history. */
  async tryRecoverPool(groupId, mode) {
    const group = this.state.group(groupId) || {};
    if (group.openingImage && fs.existsSync(group.openingImage)) {
      const result = await this.maybeReadPool({ groupId, image: group.openingImage, mode });
      if (result && result.ok) return result;
    }
    return this.recoverPool({ groupId, mode });
  }

  cancelTimers(sessionId) {
    clearTimeout(this.analysisTimers.get(sessionId));
    this.analysisTimers.delete(sessionId);
    if (this.timers.has(sessionId)) {
      clearTimeout(this.timers.get(sessionId));
      this.timers.delete(sessionId);
    }
  }

  /** Boardcast "游戏结束" — run the post-game review once and stay quiet after. */
  /** Game over: write the review artifact for the board, never post it to the
   *  group unless behavior.announceReview is explicitly turned on. */
  async onGameEnd({ groupId, event }) {
    this.turns.delete(String(groupId));
    const sessionId = `g${groupId}`;
    this.cancelTimers(sessionId);
    const group = this.state.group(groupId) || {};
    const membership=require('./participation.cjs'),key=membership.matchKey(group),participated=membership.participated(group,this.selfId);
    this.state.setGroup(groupId,{joinConfirmed:true,joinKind:null,soloToken:null,soloPendingVerification:false});
    if(group.joinReserved){this.state.setGroup(groupId,{joinReserved:false});this.state.save();}
    if (group.ended) {
      // The score broadcast also says "游戏结束" and arrives after the first
      // terminal message. Refresh the same package instead of dropping it.
      matches.save(sessionId, { refresh: true });
      return;
    }
    this.state.setGroup(groupId, { joinReserved: false, ended: true, pendingBatch:null, endedAt: new Date().toISOString() });
    this.state.save();
    try {
      if(!participated){this.log('对局结束：未确认本号参与本局，仅保存旁观记录，不生成或发送本方复盘');return null;}
      const review = await this.part2.review(sessionId, { budgetMs: this.config.behavior.inferBudgetMs });
      if(membership.matchKey(this.state.group(groupId))!==key)return null;
      if (review && review.ok) {
        artifact.setReview(sessionId, { path: review.out || null, summary: review.summary || '', result: review.result || null });
        this.log(`对局结束，复盘已生成：${review.out ? path.basename(review.out) : '(只有文字)'}`);
        if (this.config.behavior.announceReview) {
          return this.reply({ groupId, event, text: review.summary });
        }
        return null;
      }
      if (review && review.code === 'NEED_POOL') {
        this.log('对局结束：没有区块池，跳过地图复盘。');
        return null;
      }
      this.log(`对局结束，复盘生成失败：${(review && review.message) || '未知原因'}`);
      return null;
    } catch (error) {
      this.stats.errors += 1;
      this.log(`复盘失败: ${error.message}`);
      return null;
    } finally {
      try {
        if(membership.matchKey(this.state.group(groupId))!==key)return;
        const actualEndedAt=event?.time!=null&&Number.isFinite(Number(event.time))?new Date(Number(event.time)*1000).toISOString():null;
        const id=matches.save(sessionId, { endedAt: this.state.group(groupId).endedAt, actualEndedAt, terminalText: event ? this.textOf(event) : "" });
        if(id&&participated) setImmediate(()=>require('../host.cjs').get('decision-report.cjs').publish(this,String(groupId),id).catch(e=>this.log('复盘发送失败：'+e.message)));
      }
      catch (error) { this.log(`对局记录保存失败: ${error.message}`); }
    }
  }

  async appendToSession({ groupId, text, event, parsed, private: isPrivate }) {
    const sessionId = `g${groupId}`;
    const group = this.state.group(groupId) || {};
    if (!group.session) { this.log(`群 ${groupId} 还没有会话，忽略该消息`); return; }
    if (!isPrivate) text = this.roundedTrajectory(groupId, text);
    if ((/\[第\s*\d+\s*步\]/.test(text)||parsed.counts?.modeNotice||(isPrivate&&parsed.counts?.hear)) && !/【第\s*\d+\s*回合】/.test(text)) {
      const round = group.currentRound || this.turns.get(String(groupId))?.round;
      if (round) text = `【第 ${round} 回合】\n${text}`;
    }
    await this.guessSelf(sessionId, groupId, text);
    const view = this.state.group(groupId).self ?? 0;
    try {
      const result = await this.part2.append({ session: sessionId, text, view });
      if (result && result.ok) {
        if(!result.duplicate&&event?.message_id!=null){
          const journal=store.load(sessionId),message=journal?.messages?.find(m=>m.id===result.id);
          if(message){message.source={key:`${isPrivate?'private':'group'}:${event.message_id}`,time:Number(event.time)||null,addressedToSelf:(event.message||[]).some(s=>s.type==='at'&&String(s.data?.qq)===String(this.selfId))};store.save(sessionId,journal);}
        }
        this.note({ action: result.duplicate ? 'duplicate' : 'appended', type: parsed.type });
        if (!result.duplicate) artifact.addMessage(sessionId, { id: result.id, view, type: parsed.type, text, private: isPrivate });
        if (!result.duplicate) {
          this.stats.appended += 1;
          if (!this.recovering && this.config.behavior.mode === 'auto' && !group.ended && !END_GAME.test(text)) {
            clearTimeout(this.analysisTimers.get(sessionId));
            const timer=setTimeout(()=>{
              this.analysisTimers.delete(sessionId);
              if (this.state.group(groupId)?.ended || this.turns.has(String(groupId))) return;
              this.runInfer({groupId,event:null,auto:false}).catch(error=>this.log(error.message));
            }, this.config.behavior.debounceMs || 3000);
            timer.unref?.(); this.analysisTimers.set(sessionId,timer);
          }

          this.state.setGroup(groupId, { lastType: parsed.type, lastAt: new Date().toISOString() });
          this.state.save();
        }
        this.log(`录入 ${sessionId} ${parsed.type}${result.duplicate ? '（重复已忽略）' : ''}${isPrivate ? ' [私聊]' : ''}`);
      } else {
        this.log(`录入失败 ${sessionId}: ${result && result.message}`);
        if (result && result.code === 'NEED_POOL') this.pendingPoolHint = groupId;
      }
    } catch (error) {
      this.stats.errors += 1;
      this.log(`录入异常 ${sessionId}: ${error.message}`);
    }
  }

  /** Opportunistic identity detection from a [N号]昵称 listing or an explicit line. */
  async guessSelf(sessionId, groupId, text) {
    const group = this.state.group(groupId);
    if (!group || group.self != null) return;
    for (const match of String(text).matchAll(/(?:\[|@)(\d+)号(?:[：:]\s*\[?@?([^\]\n]+)|\]([^\n]+))/g)) {
      const name=String(match[2]||match[3]||'').replace(/^@+/, '').trim();
      if (this.selfNames.has(name) || name === String(this.selfId)) {
        await this.adoptPlayerNumber(groupId,Number(match[1]));return;
      }
    }
  }


  /* ----------------------------- human input ----------------------------- */

  async onHumanMessage({ event, text, groupId, userId }) {
    if (this.config.behavior.mode === 'off') return; // collect only, never answer
    const prefix = this.config.behavior.prefix.find((item) => text.trim() === item || text.trim().startsWith(item + ' ') || text.trim().startsWith(item + '\t') || text.trim().startsWith(item + '\n'));
    if (!prefix) return;
    this.note({ action: 'command' });
    const body = text.trim().slice(prefix.length).trim();
    if (!body || /^(帮助|help|说明)$/i.test(body)) return this.reply({groupId, event, text:HELP});

    // Account control ("let 大肥鱼 join") works before a session exists.
    const controlled = await this.handleControl({ event, body, groupId, userId });
    if (controlled) return controlled;

    // Public controls remain join/leave; solo creation is admin-only.
    return;
  }

  /* --------------------------- account control --------------------------- */

  /**
   * Who may drive this QQ account: the owner always; `control.allowFrom` for
   * join/leave; any member of an accepted group can ask for 加入/退出 (what the owner
   * asked for: friends can call 大肥鱼 into a game).
   */
  canControl(userId, groupId, kind) {
    const control = this.config.control || {};
    if (!control.enabled) return false;
    const id = String(userId || '');
    if (id && id === this.selfId) return true;
    if ((control.allowFrom || []).map(String).includes(id)) return true;
    if (kind === 'join' && control.allowGroupMembers && groupId) return true;
    return false;
  }

  controlRateOk(userId) {
    const limit = Number((this.config.control || {}).ratePerMinute) || 6;
    const now = Date.now();
    const key = String(userId || 'unknown');
    const hits = (this.controlHits.get(key) || []).filter((t) => now - t < 60000);
    if (hits.length >= limit) {
      this.controlHits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.controlHits.set(key, hits);
    return true;
  }

  /** Send a plain message as this account, no quote / @ — the game bot must see a bare command. */
  /** Pick up "通过「/加入」报名" style announcements from a bot-looking sender. */
  learnFromAnnouncement(groupId, event, text) {
    if (!/[\u300c\u300e"\u201c]\s*[#/!]\u52a0\u5165/.test(String(text || ''))) return null;
    const sender = String((event && event.user_id) || '');
    if (!sender || sender === this.selfId) return null;
    const senderInfo = (event && event.sender) || {};
    const name = String(senderInfo.card || senderInfo.nickname || '');
    const looksLikeBot = /bot|lgt|\u673a\u5668\u4eba/i.test(name);
    if (!looksLikeBot && !this.config.botIds.includes(sender)) return null;
    return this.learnGameBot(groupId, event, text);
  }

  /** Remember who the game bot is and which prefix it announced (「/加入」). */
  learnGameBot(groupId, event, text) {
    const sender = String((event && event.user_id) || '');
    if (!sender || !groupId) return null;
    const group = this.state.group(groupId) || {};
    const patch = {};
    if (group.gameBotId !== sender) patch.gameBotId = sender;
    const hit = String(text || '').match(/[「『"“]\s*([#/!])(?:加入|开始)/);
    if (hit && group.commandPrefix !== hit[1]) patch.commandPrefix = hit[1];
    if (Object.keys(patch).length) {
      this.state.setGroup(groupId, patch);
      this.state.save();
      this.log(`识别游戏机器人：${sender}${patch.commandPrefix ? "，命令前缀 " + patch.commandPrefix : ""}`);
    }
    return patch;
  }

  joinCommandFor(groupId) {
    const group = this.state.group(groupId) || {};
    const control = this.config.control || {};
    return group.commandPrefix ? group.commandPrefix + '加入' : (control.joinCommand || '/加入');
  }

  leaveCommandFor(groupId) {
    const group = this.state.group(groupId) || {};
    const control = this.config.control || {};
    return group.commandPrefix ? group.commandPrefix + '退出' : (control.leaveCommand || '/退出');
  }

  async speak(text, groupId, guard, decision) {
    const control = this.config.control || {};
    const group = this.state.group(groupId) || {};
    const botId = group.gameBotId || control.gameBotId || (this.config.botIds || [])[0] || null;
    const segments = [];
    if (!botId) throw new Error('尚未确认 LGTBot QQ，拒绝发送未指向机器人的指令');
    if (botId) {
      segments.push({ type: 'at', data: { qq: String(botId) } });
      segments.push({ type: 'text', data: { text: ' ' } });
    }
    const aliases = { 上: 's', 下: 'x', 左: 'z', 右: 'y' };
    const wireText = /^[上下左右]+$/.test(text) ? Array.from(text, dir => aliases[dir]).join('') : text;
    segments.push({ type: 'text', data: { text:wireText } });
    await this.throttle(groupId);
    if (guard && !guard()) return false;
    let receipt;
    if(decision?.transport==='private'){
      if(!/^(?:[上下左右]|停止)$/.test(text))throw new Error('隐匿私聊只允许单步或停止');
      receipt = await this.send({type:'private',userId:String(botId),message:[{type:'text',data:{text:wireText}}]});
    }else receipt = await this.send({ type: 'group', groupId, message: segments });
    if (/^(?:[上下左右]+|停止)$/.test(text)) {
      const session = `g${groupId}`;
      const board = artifact.load(session) || {};
      artifact.save(session, { ...board, actions: [...(board.actions || []), { at: new Date().toISOString(), direction: text, source: 'auto', status: 'sent', receiptId: receipt?.message_id ?? null, ...decision }] });
    }
    this.log(`以本号发送到 ${groupId}: ${text}`);
    this.recent.unshift({ at: new Date().toISOString(), groupId: String(groupId), target: 'self', text: `(我和机器人) ${text}` });
    if (this.recent.length > 20) this.recent.length = 20;
  }

  /** Ask the game bot for the current match info and wait for its reply. */
  askGameInfo(groupId, { timeoutMs: requestedTimeout } = {}) {
    const control = this.config.control || {};
    const prefix=this.state.group(groupId)?.commandPrefix;
    const command = ['/','#','!'].includes(prefix)?prefix+'游戏信息':control.gameInfoCommand || '/游戏信息';
    return new Promise((resolve) => {
      let settled = false;
      const timeoutMs = Number(requestedTimeout) || Number(control.gameInfoTimeoutMs) || 8000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.gameInfoPending && this.gameInfoPending.groupId === String(groupId)) this.gameInfoPending = null;
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      this.gameInfoPending = {
        groupId: String(groupId),
        resolve: (info) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.gameInfoPending = null;
          resolve({ ok: true, info });
        },
      };
      this.speak(command, groupId).catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.gameInfoPending = null;
        resolve({ ok: false, reason: 'send-fail', message: error.message });
      });
    });
  }

  /** Called for every incoming event; resolves a pending /游戏信息 query. */
  tryResolveGameInfo(event) {
    if (!this.gameInfoPending) return false;
    if (!event || event.post_type !== 'message' || event.message_type !== 'group') return false;
    const groupId = event.group_id ? String(event.group_id) : null;
    if (!groupId || groupId !== this.gameInfoPending.groupId) return false;
    const group = this.state.group(groupId) || {};
    const control = this.config.control || {};
    const botId = group.gameBotId || control.gameBotId || (this.config.botIds || [])[0];
    const sender = event.user_id ? String(event.user_id) : null;
    if (!botId || !sender || sender !== String(botId)) return false;
    const text = this.textOf(event);
    const name = (text.match(/游戏名称[:：]\s*([^\n\r]+)/) || [])[1];
    if (/该房间未进行游戏/.test(text)) {
      this.gameInfoPending.resolve({ name: '', noMatch: true, text });
      return true;
    }
    if (!name) return false;
    this.gameInfoPending.resolve({ name: String(name).trim(), text });
    return true;
  }

  unsupportedConfig(text) {
    return require('./room-rules.cjs').readRoom(text).bad;
  }

  /** Before joining, check the room is actually a game we support. */
  async ensureSupportedGame({ groupId, event, deny, timeoutMs }) {
    const control = this.config.control || {};
    const query = await this.askGameInfo(groupId, {timeoutMs});
    if (!query.ok) {
      return deny(query.reason === 'timeout'
        ? '不加入：问「' + (control.gameInfoCommand || '/游戏信息') + '」没等到机器人回话（超时），先不加入。'
        : '不加入：' + (query.message || '问不到当前游戏信息') + '。');
    }
    if (query.info.noMatch) return deny('不加入：这个房间还没有进行中的游戏。');
    const name = query.info.name;
    this.state.setGroup(groupId, { gameInfo: { name, at: new Date().toISOString() } });
    this.state.save();
    const supported = supportedGames.names;
    if (!name) return deny('不加入：没解析出游戏名，先不加入。');
    if (!supported.includes(name)) {
      return deny('不加入：这个房间是「' + name + '」，我只支持：' + supported.join('、') + '。');
    }
    const {readRoom,events}=require('./room-rules.cjs');
    const {values:rules,bad:unsupported,missing}=readRoom(query.info.text||'');
    if (unsupported.length) {
      const list = unsupported.map((item) => item.name + '=' + item.current + '（' + item.why + '）').join('；');
      return deny('不加入：这个房间的配置里有我不支持的项 —— ' + list + '。');
    }
    if (missing.length) return deny('不加入：游戏配置不完整，无法确认：' + missing.join('、'));
    this.state.setGroup(groupId,{joinSettings:{
      roomRules:rules,mode:rules.模式,size:Number(rules.边长),silent:rules.静音==='开启',
      expandedPool:rules.拓展==='开启',portalChaos:rules.传送紊乱==='开启',deliberate:rules.谋定后动==='开启',dark:rules.摸黑==='开启',captureTarget:rules.捕捉目标==='下家'?'NEXT':'PREVIOUS',
      event:events[rules.特殊事件],pool:rules.区块==='默认'?undefined:rules.区块.toUpperCase(),
    }});
    this.state.save();
    return null;
  }

  async handleControl({ event, body, groupId, userId }) {
    const control = this.config.control || {};
    if (!control.enabled || !groupId) return null;
    const deny = async (text) => { await this.reply({ groupId, event, text }); return true; };
    const done = async (text) => {
      if (control.confirm) await this.reply({ groupId, event, text });
      return true;
    };

    if (body === '战绩') {
      if (!this.canControl(userId, groupId, 'join')) return deny('当前没有权限让宽松查询战绩。');
      if (!this.controlRateOk(userId)) return deny('操作太频繁了，等一分钟再试。');
      const prefix = this.state.group(groupId)?.commandPrefix || String(control.joinCommand || '/加入')[0];
      if (!['/', '#', '!'].includes(prefix)) return deny('LGTBot 命令前缀无效，不能查询战绩。');
      const command = prefix + '战绩';
      try {
        await this.speak(command, groupId);
        this.note({ action: 'record' });
      } catch (error) {
        this.stats.errors += 1;
        return deny('战绩查询发送未确认，请先核对 LGTBot 回应；本次不会自动重发。');
      }
      return done('已向 LGTBot 发送「' + command + '」，查询宽松自己的战绩。');
    }

    if (/^(?:单机|单机对局)(?:\s|$)/.test(body.trim())) {
      // Do not reuse canControl(): ordinary members and allowFrom may join,
      // but only the explicit administrator list may create a solo room.
      if (!(control.adminIds || []).map(String).includes(String(userId))) return deny('只有配置中的管理员可以开启单机对局。');
      const solo=require('./solo-games.cjs');let request;
      try{request=solo.parse(body);}catch(error){return deny(error.message);}
      if(!this.controlRateOk(userId))return deny('操作太频繁了，等一分钟再试。');
      const occupied=Object.values(this.state.data.groups||{}).some(g=>g.joinReserved||(g.session&&!g.ended));
      if(occupied)return deny('不能开单机：已有进行中或正在加入的游戏，请先在原群退出。');
      const botId=this.state.group(groupId)?.gameBotId||control.gameBotId||this.config.botIds?.[0];
      if(!botId)return deny('尚未确认 LGTBot QQ，不能开启单机。');
      const mode=request.mode,token=require('node:crypto').randomUUID();
      const prefix=this.state.group(groupId)?.commandPrefix||String(control.joinCommand||'/加入')[0];
      if(!['/','#','!'].includes(prefix))return deny('LGTBot 命令前缀无效，不能开启单机。');
      const command=prefix+'新游戏 '+request.game+' '+request.tokens.join(' ')+' 单机';
      this.state.setGroup(groupId,{joinReserved:true,joinConfirmed:false,joinSettings:null,gameBotId:String(botId),joinKind:'solo',soloToken:token,
        soloPendingVerification:true,soloRequestedBy:String(userId),joinRequestedAt:new Date().toISOString()});
      this.state.save();
      const current=()=>this.state.group(groupId)?.soloToken===token&&this.state.group(groupId)?.joinReserved===true;
      const release=()=>{if(current()){this.state.setGroup(groupId,{joinReserved:false,joinKind:null,soloToken:null,soloPendingVerification:false,joinSettings:null});this.state.save();}};
      let creating=false;
      try{
        const query=await this.askGameInfo(groupId);
        if(!current())return true;
        if(!query.ok){release();return deny('未开单机：未能确认房间空闲，请稍后重试。');}
        if(!query.info.noMatch){release();return deny('未开单机：本群已有游戏，不会覆盖或解散现有房间。');}
        // Set before sending: a transport failure may still mean delivered.
        creating=true;
        const sent=await this.speak(command,groupId,current);
        if(sent===false){release();return true;}
        // SINGLE_USER starts immediately. Incoming events are queued behind
        // this handler; the trusted info reply resolves outside that queue.
        // Store the real room settings before processing the opening and DM.
        // Single-player creation sends the map, wall DM and turn prompt before
        // answering this query. Keep the resolver alive through that backlog.
        const refused=await this.ensureSupportedGame({groupId,event,timeoutMs:30000,deny:text=>deny('单机创建已请求，配置核验未通过，暂停自动行动。'+text)});
        if(!current())return true;
        if(refused)return true;
        const mismatch=solo.mismatches(request,this.state.group(groupId)?.joinSettings?.roomRules||{});
        if(mismatch.length)return deny('单机创建已请求，但实际配置与请求不符，暂停自动行动：'+mismatch.join('；'));
        this.state.setGroup(groupId,{soloPendingVerification:false});this.state.save();
        this.note({action:'solo'});
        return done('已发送'+request.game+'「'+request.label+'」单机开局指令，配置核验通过；收到本人行动提示后自动游玩。');
      }catch(error){
        if(!creating)release();
        this.stats.errors+=1;
        return deny(creating?'单机指令发送结果或配置核验不确定，已保留占用并暂停自动行动；请核对 LGTBot 回应。':'未开单机：'+error.message);
      }
    }

    if(body.trim()==='重置'){
      if(!(control.adminIds||[]).map(String).includes(String(userId)))return true;
      this.turns.delete(String(groupId));
      this.cancelTimers('g'+groupId);
      this.pending.delete('g'+groupId);
      this.state.setGroup(groupId,{joinReserved:false,joinConfirmed:false,joinSettings:null,joinKind:null,soloToken:null,soloPendingVerification:false,ended:true,pendingBatch:null,lastActionPromptId:null,uncertainPromptId:null,lastDismissedAt:new Date().toISOString()});
      this.state.save();
      return done('本群宽松状态已重置，可以重新加入。');
    }

    const join = body.match(/^(?:加入|进游戏|join)\s*([A-Za-z0-9]*)$/i);
    if (join) {
      if (join[1]) return deny('不加入：只支持校验并加入当前群房间，不支持指定其他房间号。');
      if (!this.canControl(userId, groupId, 'join')) return deny('只有主人或白名单里的人能让这个号加入。');
      if (!this.controlRateOk(userId)) return deny('操作太频繁了，等一分钟再试。');
      const occupied = Object.entries(this.state.data.groups || {}).find(([, g]) => g.joinReserved || (g.session && !g.ended));
      if (occupied) return deny('不加入：已有进行中或正在加入的游戏，请先在原群退出。');
      // Persist before the first await so concurrent groups and restarts share the lock.
      this.state.setGroup(groupId, { joinReserved: true, joinConfirmed:false,joinKind:'join',soloToken:null,soloPendingVerification:false, joinRequestedAt:new Date().toISOString() });
      this.state.save();
      let command;
      try {
        const refused = await this.ensureSupportedGame({ groupId, event, deny });
        if (refused) {
          this.state.setGroup(groupId, { joinReserved: false });
          this.state.save();
          return refused;
        }
        this.note({ action: 'join' });
        command = this.joinCommandFor(groupId);
        await this.speak(command, groupId);
      } catch (error) {
        // A failed transport can still have delivered the command; keep the lock.
        this.stats.errors += 1;
        return deny('发送失败：' + error.message + '；请在本群退出后重试。');
      }
      return done('已用 ' + this.selfId + ' 的号发送「' + command + '」。');
    }

    const leave = body.match(/^(?:退出|离开|leave)$/i);
    if (leave) {
      if (!this.canControl(userId, groupId, 'join')) return deny('只有主人或白名单里的人能让这个号退出。');
      if (!this.controlRateOk(userId)) return deny('操作太频繁了，等一分钟再试。');
      this.note({ action: 'leave' });
      const command = this.leaveCommandFor(groupId);
      try {
        await this.speak(command, groupId);
        this.state.setGroup(groupId, { joinReserved: false, ended: true,joinKind:null,soloToken:null,soloPendingVerification:false });
        this.state.save();
      } catch (error) {
        this.stats.errors += 1;
        return deny('发送失败：' + error.message);
      }
      return done('已用 ' + this.selfId + ' 的号发送「' + command + '」。');
    }

    return null;
  }

  /* --------------------------- history recovery --------------------------- */

  /** Last group message carrying the opening broadcast ("[提示] 本局游戏人数为 …"). */
  async findOpening(groupId) {
    if (!this.history) return null;
    const messages = await this.history(groupId, 60);
    let found = null;
    for (const message of messages) if (/本局游戏人数为\s*\d+\s*人/.test(this.textOf(message))) found = message;
    return found;
  }

  /** Rebuild a session from chat history (covers a bot restart mid-game). */
  async recoverSession({ groupId, event }) {
    this.turns.delete(String(groupId));
    const sessionId = `g${groupId}`;
    const opening = await this.findOpening(groupId);
    if (!opening) return this.reply({ groupId, event, text: '翻不到本局的开局公告（可能已经翻过 60 条），可以发「#宽松 设置 模式:幻变 人数:4 本人:0 边长:9」手动指定。' });
    const text = this.textOf(opening);
    const mode = (text.match(/【区块模式】\s*(经典|幻变|狂野|疯狂|按钮|陷阱|空旷|无声)/) || [])[1];
    const players = Number((text.match(/本局游戏人数为\s*(\d+)\s*人/) || [])[1]) || undefined;
    const exits = Number((text.match(/逃生舱数量为\s*(\d+)\s*个/) || [])[1]) || undefined;
    const group = this.state.group(groupId) || {};
    const init = await this.part2.init({
      session: sessionId,
      settings: { mode, players, exitCount: exits, force: true, self: group.self == null ? undefined : group.self },
      meta: { group: groupId },
    });
    if (!init || !init.ok) return this.reply({ groupId, event, text: `重建失败：${(init && init.message) || "未知原因"}` });
    const view = group.self == null ? 0 : Number(group.self);
    await this.part2.append({ session: sessionId, text, view });
    let privateAdded = 0;
    if (this.privateHistory) {
      const botId = group.gameBotId || (this.config.control || {}).gameBotId || (this.config.botIds || [])[0];
      if (botId) {
        try {
          const privates = await this.privateHistory(botId, 30);
          for (const message of privates) {
            const body = this.textOf(message);
            if (!/【开局】|完整赛况|你听见了|声响/.test(body)) continue;
            await this.part2.append({ session: sessionId, text: body, view });
            privateAdded++;
          }
        } catch (error) {
          this.log(`读私聊历史失败：${error.message}`);
        }
      }
    }
    this.state.setGroup(groupId, { session: sessionId, ended: false });
    this.state.data.lastGroup = String(groupId);
    this.state.data.lastSession = sessionId;
    this.state.save();
    const pool = await this.recoverPool({ groupId, opening, mode });
    const lines = [`已从聊天记录重建本局：${mode || "?"} / ${players || "?"} 人`];
    if (privateAdded) lines.push(`补录私聊 ${privateAdded} 条`);
    lines.push(pool && pool.ok ? `区块池（${pool.confidence}）：${pool.pool}` : "开局图没读到，发「#宽松 读图」重试，或手动「#宽松 池 …」");
    return this.reply({ groupId, event, text: lines.join("\n") });
  }

  /** Find the pool sheet in history (or the saved file) and write it into the session. */
  async recoverPool({ groupId, opening, mode }) {
    const sessionId = `g${groupId}`;
    const group = this.state.group(groupId) || {};
    const candidates = [];
    if (group.openingImage && fs.existsSync(group.openingImage)) candidates.push({ payload: { file: group.openingImage }, message: null });
    if (this.history) {
      const messages = opening ? [opening] : await this.history(groupId, 40);
      for (const message of messages) {
        const text = this.textOf(message);
        const weight = /本局可能出现的区块|区块模式/.test(text) ? 2 : 1;
        for (const payload of this.imagesOf(message)) candidates.push({ payload, message, weight });
      }
    }
    candidates.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    for (const candidate of candidates.slice(0, 6)) {
      let saved;
      try {
        saved = await saveImageData([candidate.payload], { group_id: Number(groupId), message_id: Date.now() }, { logger: this.log });
      } catch (error) {
        this.log(`下载开局图失败：${error.message}`);
        continue;
      }
      if (!saved || !saved.length) continue;
      const result = await this.part2.poolRead({ image: saved[0], mode, session: sessionId });
      if (result && result.ok && result.confidence !== "low") {
        artifact.setPool(sessionId, { ids: result.ids, confidence: result.confidence, texture: result.texture, image: saved[0], tiles: result.tiles });
        this.state.setGroup(groupId, { openingImage: saved[0], imagePool: result.pool, imagePoolConfidence: result.confidence });
        this.state.save();
        return result;
      }
    }
    return null;
  }

  /** Learn player seats only from the judge's explicit turn prompt and its @ target. */
  learnPromptPlayer(groupId,event,text,turn) {
    const group=this.state.group(groupId)||{};
    if(!group.session||String(group.gameBotId||'')!==String(event?.user_id)||turn?.player==null||!/(?:在公屏选择方向移动|请继续行动)/.test(String(text||'')))return;
    const ids=this.mentionedUserIds(event);
    if(ids.length!==1)return;
    const playerUsers={...(group.playerUsers||{}),[ids[0]]:Number(turn.player)};
    const participation=require('./participation.cjs').proofForPrompt(group,this.selfId,event,turn,ids);
    this.state.setGroup(groupId,{playerUsers,...(participation?{participation}:{})});
    if(participation)artifact.setSettings(group.session,{matchKey:participation.matchKey,participation});
    this.state.save();
  }

  mentionedUserIds(event) {
    const ids=new Set();
    for(const segment of event?.message||[]) {
      if(segment?.type==='at'&&segment.data?.qq&&String(segment.data.qq)!=='0')ids.add(String(segment.data.qq));
      if(segment?.type==='markdown')for(const match of String(segment.data?.content||'').matchAll(/mqqapi:\/\/markdown\/mention\?([^)]*)/g)) {
        const params=new URLSearchParams(match[1].replace(/&amp;/g,'&'));
        const id=params.get('at_tinyid');if(id)ids.add(String(id));
      }
    }
    return [...ids];
  }

  /** Preserve the judge's explicit first-sound/no-broadcast fact with its known actor. */
  publicFirstSoundClue(groupId,event,text) {
    const source=String(text||'');
    if(!/本局首次发声/.test(source)||/(?:\d+号\s*(?:第\s*\d+\s*回合\s*)?第\s*\d+\s*步\s*[^\n]*首次发声)/.test(source))return source;
    const group=this.state.group(groupId)||{};
    if(!group.session||String(group.gameBotId||'')!==String(event?.user_id))return source;
    const step=source.match(/\[第\s*(\d+)\s*步\]/);if(!step)return source;
    const seats=new Set(this.mentionedUserIds(event).map(id=>group.playerUsers?.[id]).filter(Number.isInteger));
    if(seats.size!==1)return source;
    const player=[...seats][0],round=Number(group.currentRound)||1;
    return `${source}\n${player}号第${round}回合第${Number(step[1])}步首次发声`;
  }

  /* ------------------------------- inference ----------------------------- */

  roundedTrajectory(groupId, text) {
    const route = String(text).match(/^\s*\[(\d+)号\][^\n]*完整行动轨迹/);
    if (!route || /【第\s*\d+\s*回合】/.test(text)) return text;
    const group = this.state.group(groupId) || {};
    const current = this.turns.get(String(groupId));
    const player = Number(route[1]);
    const round = group.currentRound || (current?.player === player && current.round)
      || (Number(group.routeRounds?.[player] || 0) + 1);
    this.state.setGroup(groupId, { routeRounds: { ...group.routeRounds, [player]: round } });
    this.state.save();
    return `【第 ${round} 回合】\n${text}`;
  }

  /** Turn events: "请 [0号：@我] …选择方向移动", "@我 / 请继续行动", "…本回合结束". */
  detectTurnPrompt(event, text) {
    const body = String(text || '');
    const mentions = Array.isArray(event && event.message)
      ? event.message.filter(segment => segment?.type === 'at' && String(segment.data?.qq) !== '0') : [];
    // QQ markdown sometimes drops the structured at segment. Match only the
    // exact addressee in the first line, never a name quoted in the feedback.
    const header = body.split('\n')[0].trim();
    const addressee = header.match(/^@+([^\n]+?)\s*$/)?.[1]
      || header.match(/^请\s*\[?@?\d+号[：:]\s*\[?@+([^\]]+)\]/)?.[1];
    const mentioned = mentions.length
      ? mentions.some(segment => String(segment.data.qq) === String(this.selfId))
      : !!addressee && (this.selfNames.has(addressee.trim()) || addressee.trim() === String(this.selfId));
    const hit = body.match(/(?:\[|@)(\d+)号[：:]/);
    const player = hit ? Number(hit[1]) : null;
    if (/在公屏选择方向移动/.test(body)) return { ours: mentioned, player, kind: 'start' };
    if (mentioned&&/已抵达【逃生舱】！不再参与后续游戏/.test(body)) return { ours:true, player, kind:'end' };
    if (/请继续行动/.test(body)) return { ours: mentioned, player, kind: 'continue' };
    if (/本回合结束/.test(body)) return { ours: mentioned, player, kind: 'end' };
    if (/\[第\s*\d+\s*步\]\s*向\s*[上下左右]\s*移动/.test(body)) return {ours:mentioned,player,kind:'continue'};
    return null;
  }

  /** Round number for the current turn: one past whatever the journal already holds. */
  async nextRound(sessionId) {
    try {
      const status = await this.part2.status(sessionId);
      const rounds = (status && status.ok && status.status.rounds) || [];
      return (rounds.length ? Math.max(...rounds) : 0) + 1;
    } catch {
      return 1;
    }
  }

  /** Append the steps of the current turn as a round-marked trajectory fragment.
   *  part2 replaces an earlier fragment of the same round, so the journal always
   *  holds the best-known partial route for this turn. */
  async recordPartialTurn(sessionId) {
    const current = this.turns.get(sessionId.replace(/^g/, ""));
    if (!current || !current.steps.length) return;
    const player = this.state.group(sessionId.replace(/^g/,''))?.self ?? current.player;
    if(player==null){this.recoveryRequested=true;return;}
    const text = `【第 ${current.round} 回合】\n[${player}号]玩家正在行动中：\n${current.steps.join('')}`;
    try {
      if(this.recovering&&store.load(sessionId)?.messages?.some(m=>m.view===player&&m.text===text))return;
      const appended=await this.part2.append({ session: sessionId, text, view: player });
      if(appended?.ok&&!appended.duplicate)artifact.addMessage(sessionId, { type: '行动轨迹（进行中）', text, private: false });
    } catch (error) {
      this.log(`记录当前回合轨迹失败: ${error.message}`);
    }
  }

  async handleTurn({ event, text, groupId, turn }) {
    groupId = String(groupId);
    const sessionId = `g${groupId}`;
    let current = this.turns.get(groupId);
    const feedback = String(text || "");
    const messageId=event?.message_id==null?null:String(event.message_id);
    const eventTime=Number(event?.time)*1000;
    const explicitRound=Number(feedback.match(/【第\s*(\d+)\s*回合】/)?.[1])||null;
    // Content repeats across timeout rounds; deduplicate deliveries, not turns.
    if(current&&messageId!=null&&current.promptId===messageId)return;
    if(current&&Number.isFinite(eventTime)&&Number.isFinite(current.promptTime)&&eventTime<current.promptTime)return;
    if(current&&explicitRound!=null&&explicitRound<current.round)return;
    if (turn.kind === 'start') {
      const round=explicitRound||this.state.group(groupId)?.currentRound||await this.nextRound(sessionId);
      if(current&&round<current.round)return;
      if(current&&round===current.round&&current.feedback===feedback)return;
      current = { groupId, round, steps: [], player: turn.player };
      current.feedback = feedback;
      current.promptTime=Number(event?.time)*1000;
      current.startedTime=current.promptTime;
      current.promptId = event?.message_id == null ? null : String(event.message_id);
      this.turns.set(groupId, current);
      if (turn.player != null) await this.adoptPlayerNumber(groupId, turn.player);
      if (this.config.behavior.mode === 'auto') this.scheduleInfer(sessionId, { groupId, event }, 400);
      return;
    }
    if (turn.kind === 'continue') {
      if(current&&explicitRound!=null&&explicitRound>current.round){
        // Do not append a new round to stale steps. Rebuild from its journal.
        this.turns.delete(groupId);current=null;
      }
      if(current&&current.feedback===feedback)return;
      if (turn.player != null) await this.adoptPlayerNumber(groupId, turn.player);
      const dir = (String(text || '').match(/\[第 \d+ 步\] 向 (上|下|左|右) 移动/) || [])[1];
      if (!current || current.groupId !== groupId) {
        current = { groupId, round: explicitRound||this.state.group(groupId)?.currentRound || await this.nextRound(sessionId), steps: [], player: this.state.group(groupId)?.self ?? turn.player };
        const step=Number(feedback.match(/\[第\s*(\d+)\s*步\]/)?.[1]);
        if(step>1){
          const journal=store.load(sessionId);
          for(const m of journal?.messages||[]){
            const route=kernel.M.parse(m.text).items.find(t=>t.kind==='trajectory'&&t.partial&&t.player===current.player&&t.round===current.round);
            if(route&&route.tokens.filter(t=>t.kind==='move').length===step-1)
              current.steps=m.text.split('\n').at(-1).match(/\[[^\]]+\]|[↑↓←→]/g)||[];
          }
          if(current.steps.length!==step-1){this.recoveryRequested=true;this.log('当前回合步骤缺失，先补录历史再行动');return;}
        }
      }
      current = { ...current, steps: [...current.steps], feedback, promptTime:Number(event?.time)*1000, sent: false, promptId: event?.message_id == null ? null : String(event.message_id) };
      current.feedbackSender=String(event?.user_id);
      this.turns.set(groupId, current);
      if (dir) {
        const arrow = { 上: '↑', 下: '↓', 左: '←', 右: '→' }[dir];
        const sound = /移动进入【(?:树丛|草丛|浆果丛)】/.test(feedback) ? '沙沙' : feedback.match(/移动发出【(啪嗒|沙沙|啪啪)声】/)?.[1];
        current.steps.push(sound ? `[${arrow}${sound}${/本局首次发声/.test(feedback) ? '(首次)' : ''}]` : arrow);
      }
      await this.recordPartialTurn(sessionId);
      const batch=this.state.group(groupId)?.pendingBatch,step=Number(feedback.match(/\[第\s*(\d+)\s*步\]/)?.[1]);
      if(batch&&batch.round===current.round&&step<batch.endStep){current.sent=true;return;}
      if(batch&&(!this.recovering||batch.round===current.round)){this.state.setGroup(groupId,{pendingBatch:null});this.state.save();}
      if(!/请继续行动/.test(feedback))return;
      if (this.config.behavior.mode === 'auto') this.scheduleInfer(sessionId, { groupId, event }, 300);
      return;
    }
    if (turn.kind === 'end') {
      const batch=this.state.group(groupId)?.pendingBatch;
      if(batch&&(!this.recovering||batch.round===current?.round)){this.state.setGroup(groupId,{pendingBatch:null});this.state.save();}
      this.turns.delete(groupId);
      this.cancelTimers(sessionId);
    }
  }

  /** The turn prompt also tells us which player number this account is. */
  async adoptPlayerNumber(groupId, player) {
    const group = this.state.group(groupId) || {};
    if (group.self != null && Number(group.self) === Number(player)) {
      await this.flushPrivate(String(groupId));
      return;
    }
    const sessionId = `g${groupId}`;
    if (!group.session) return;
    try {
      await this.part2.append({ session: sessionId, text: `我是${player}号`, view: Number(player) });
      this.state.setGroup(groupId, { self: Number(player) });
      this.state.save();
      await this.flushPrivate(String(groupId));
      this.log(`由行动提示确认本人是 ${player} 号`);
    } catch (error) {
      this.log(`记录本人编号失败: ${error.message}`);
    }
  }

  scheduleInfer(sessionId, context, delayMs) {
    if (this.recovering) return;
    const group = this.state.group(sessionId.replace(/^g/, ''));
    if (group && group.ended) return;
    if (this.timers.has(sessionId)) clearTimeout(this.timers.get(sessionId));
    const expectedTurn=this.turns.get(sessionId.replace(/^g/, ''));
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      const groupId = sessionId.replace(/^g/, '');
      if(expectedTurn&&(this.turns.get(groupId)!==expectedTurn||expectedTurn.sent))return;
      this.runInfer({ groupId, event: context.event, auto: true }).catch((error) => this.log(`自动推理失败: ${error.message}`));
    }, delayMs == null ? this.config.behavior.debounceMs : delayMs);
    if (timer.unref) timer.unref();
    this.timers.set(sessionId, timer);
  }

  /** The single direction character the game accepts for a suggestion. */
  moveChar(report) {
    const primary = report && report.suggestion && report.suggestion.primary;
    const suggestion = report && report.suggestion;
    if(suggestion?.ok&&primary?.direction==='stop'&&require('../night-strategist/mode-policy.cjs').canStopForMode(suggestion))return '停止';
    // Ending a confirmed live turn does not rely on any map coordinate.
    // The caller still enforces actor/round/fresh-feedback and duplicate guards.
    if(suggestion?.ok&&primary?.direction==='stop'&&suggestion.tactic?.kind==='finish-uncertain'
      &&require('../night-strategist/stop-policy.cjs').mayStop(suggestion))return '停止';
    if (!suggestion || !suggestion.ok || report.verification?.status === 'impossible' || (suggestion.warnings || []).some(w => /矛盾|冲突/.test(w))) return null;
    if (!primary) return null;
    const actionRules=require('../night-strategist/action-rules.cjs');
    if(actionRules.trappedFinish(suggestion))return ({up:'上',down:'下',left:'左',right:'右'})[primary.direction]||null;
    if(primary.direction==='stop'&&!actionRules.mayStop(suggestion))return null;
    // A confirmed hedge can be passable with momentum even if labeled as a wall.
    const passableHedge = primary.blocked === false && primary.wallKinds?.length === 1 && primary.wallKinds[0] === 2;
    if((primary.intentionalCollision||primary.blocked||(primary.wall==='墙'&&!passableHedge))&&!actionRules.capture(suggestion))return null;
    const capture = suggestion.tactic;
    const permittedFinish = (capture?.kind === 'finish-capture'
      && capture.target?.r === suggestion.position?.r && capture.target?.c === suggestion.position?.c);
    const projectionMatches=capture?.target?.source==='silent-layouts'&&require('../night-strategist/silent-projection.cjs').matchesReport(report);
    if(capture?.target?.source==='silent-layouts'&&!projectionMatches)return null;
    const exactFinish=permittedFinish&&capture.round>1&&(projectionMatches||['same-cell-sound','aligned-map'].includes(capture.target?.source));
    const projectedCandidates=report.board?.opponentProjection;
    const candidateProof=capture?.candidates?.source==='silent-layouts'&&projectedCandidates&&!projectedCandidates.partial
      &&projectedCandidates.player===capture.target&&projectedCandidates.round===(capture.target<report.self?capture.round:capture.round-1)
      &&projectedCandidates.round===capture.candidates.round&&JSON.stringify(projectedCandidates.positions)===JSON.stringify(capture.candidates.positions);
    if(capture?.candidates?.source==='silent-layouts'&&!candidateProof)return null;
    const candidateFinish=capture?.kind==='attempt-capture'&&capture.round>1&&capture.steps>=1
      &&(candidateProof||['candidate-alignment','sound-endpoint'].includes(capture.candidates?.source))&&capture.candidates.exhaustive===true
      &&capture.candidates.positions?.length>0&&capture.candidates.positions.length<=8
      &&capture.candidates.positions.some(p=>p.r===suggestion.position?.r&&p.c===suggestion.position?.c)
      &&capture.destination?.r===suggestion.position?.r&&capture.destination?.c===suggestion.position?.c;
    const objectiveTrapped=capture?.policy===require('../night-strategist/objective-policy.cjs').VERSION
      &&suggestion.moves?.length===4&&suggestion.moves.every(m=>m.blocked);
    const boundedFinish=require('../night-strategist/nov02-policy/bounded-exploration.cjs').isBoundedFinish(suggestion);
    const explorationFinish=boundedFinish||capture?.kind==='finish-exploration'&&capture.exhausted===true
      &&(capture.round>1||capture.loopPrevented===true)&&(capture.steps>=2||objectiveTrapped
        ||capture.policy===require('../night-strategist/objective-policy.cjs').VERSION&&capture.steps>=1);
    const protectedFinish=capture?.kind==='finish-protected-opening'&&capture.round===1&&capture.steps>=2
      &&capture.target?.target!=null&&(projectionMatches||['same-cell-sound','aligned-map'].includes(capture.target?.source));
    const solidWall=m=>m?.blocked&&m.wall==='墙'&&(!m.wallKinds?.length||m.wallKinds.every(k=>k===1||k===3));
    if(primary.direction==='stop'){
      if(!require('../night-strategist/stop-policy.cjs').mayStop(suggestion))return null;
      if(capture?.policy===require('../night-strategist/objective-policy.cjs').VERSION
        &&capture.kind==='finish-exploration'&&capture.stopException==='objective-exhausted')return '停止';
      if(capture?.kind==='portal-joint-plan')return '停止';
      const portal=capture?.kind==='portal-heartbeat-wait'&&actionRules.mayStop(suggestion);
      if(portal)return '停止';
      if((suggestion.moves||[]).some(solidWall)&&capture?.stopException!=='unresolved-loop')return null;
      return (exactFinish||candidateFinish)&&capture.stopException==='capture-no-wall'
        ||(explorationFinish||protectedFinish)&&capture.stopException==='no-safe-wall-route'
        ||explorationFinish&&capture.stopException==='unresolved-loop'&&capture.commandLoop ? '停止':null;
    }
    const hedgeFinish=exactFinish&&primary.blocked&&primary.wallKinds?.length===1&&primary.wallKinds[0]===2
      &&Number.isInteger(primary.arrivalDirection)&&primary.arrivalDirection!==primary.dirIndex;
    const intentional=primary.intentionalCollision===true&&(solidWall(primary)||hedgeFinish)
      &&(exactFinish||candidateFinish||(explorationFinish||protectedFinish)&&capture.finishMethod==='wall')
      &&primary.to?.r===suggestion.position?.r&&primary.to?.c===suggestion.position?.c;
    if (primary.blocked && !intentional) return null;
    const board=report.board, pos=board?.position;
    const edge={up:'u',down:'d',left:'l',right:'r'}[primary.direction];
    if (pos && board.cells?.[pos.r]?.[pos.c]?.[edge] === '墙' && !intentional) return null;
    return ({ up: '上', down: '下', left: '左', right: '右' })[primary.direction] || null;
  }

  async ensureOpeningWalls(groupId,self,stillCurrent){
    const group=this.state.group(groupId),session=group?.session,journal=session&&store.load(session);
    if(!journal)return false;
    if(journal.base?.config?.dark===true)return true;
    const opening=text=>String(text).includes('【开局】')&&kernel.M.parse(text).items.some(i=>i.kind==='walls'&&i.opening&&/^[墙空]{4}$/.test(i.value));
    const recorded=j=>j?.messages?.some(m=>m.view===self&&m.receiverConfirmed!==false&&opening(m.text));
    if(recorded(journal))return true;
    const botId=String(group.gameBotId||''),start=Date.parse(group.startedAt);
    if(!botId||!Number.isFinite(start)||!this.privateHistory)return false;
    const unique=()=>Object.values(this.state.data.groups).filter(g=>!g.ended&&g.session&&String(g.gameBotId)===botId).length===1;
    if(!unique())return false;
    const events=await this.privateHistory(botId,60);
    if(!stillCurrent()||!unique()||this.state.group(groupId)?.startedAt!==group.startedAt)return false;
    const matches=events.filter(e=>String(e.user_id)===botId&&Number(e.time)*1000>=start-2000&&Number(e.time)*1000<=start+120000&&opening(this.textOf(e)));
    if(matches.length===1&&!recorded(store.load(session))){
      const event=matches[0],text=this.textOf(event);
      await this.appendToSession({groupId,event,text,parsed:this.inspect(text),private:true});
    }
    return recorded(store.load(session));
  }

  async reconcileHeartbeat(groupId, turn, self, stillCurrent) {
    if (!this.privateHistory || !turn.promptId || !Number.isFinite(turn.startedTime) ||
        !Number.isFinite(turn.promptTime) || !turn.feedback?.includes('巨大的心跳声响彻了整个迷宫')) return;
    const step = Number(turn.feedback.match(/\[第\s*(\d+)\s*步\]\s*向\s*[上下左右]\s*移动/)?.[1]);
    if (!step || step !== turn.steps.length || step > 19 || step % 3 !== 1) return;
    const group = this.state.group(groupId), botId = group.gameBotId;
    const active = Object.values(this.state.data.groups).filter(g => g.session && !g.ended && String(g.gameBotId) === String(botId));
    if (!botId || String(botId)!==turn.feedbackSender || active.length !== 1) return;
    const marker = `【第 ${turn.round} 回合】\n线索确认 heartbeat:${self}:${turn.round}:${step}：未收到声音私聊`;
    const journal = store.load(group.session);
    if (!journal || journal.messages.some(m => m.view === self && (m.text === marker ||
        kernel.M.parse(m.text).items.some(i => i.kind === 'personalSound' && i.round === turn.round && i.step === step)))) return;
    // LGTBot issues the private terrain feedback before it releases the public
    // movement reply. Allow for delivery skew, then check a covering history page.
    const wait = Math.max(0, turn.promptTime + 2000 - Date.now());
    if (wait > 2000) return;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    if (!stillCurrent()) return;
    let timer, rows;
    try {
      rows = await Promise.race([this.privateHistory(botId, 60),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
    } catch { return; } finally { clearTimeout(timer); }
    if (!stillCurrent() || !Array.isArray(rows)) return;
    const trusted = rows.filter(e => String(e.user_id) === String(botId) && Number(e.time) > 0);
    if (!trusted.some(e => Number(e.time)*1000 < turn.startedTime)) return;
    for (const e of trusted.filter(e => Number(e.time)*1000 >= turn.startedTime)) {
      const text = this.textOf(e);
      if (!kernel.M.parse(text).items.some(i => i.kind === 'personalSound' && i.step === step)) continue;
      if (Number(e.time)*1000 === turn.startedTime || Number(e.time)*1000 > turn.promptTime+5000) return;
      await this.appendToSession({groupId,event:e,text,parsed:this.inspect(text),private:true});
      return;
    }
    const result = await this.part2.append({session:group.session,view:self,text:marker});
    if (result?.ok && !result.duplicate) artifact.addMessage(group.session,{id:result.id,view:self,type:'心跳私聊核验',text:marker,private:false});
  }

  async ensurePreviousCoins(groupId,turn,stillCurrent) {
    const group=this.state.group(groupId),round=turn.round-1;
    if(round<1||group.coinSettlementRound===round)return true;
    if(!this.history||!group.startedAt)return false;
    const journal=store.load(group.session);
    if(!journal)return false;
    const options={round,players:journal.base.config.playerCount,botId:group.gameBotId,
      startedAt:Date.parse(group.startedAt),groupId,textOf:e=>this.textOf(e)};
    let settlement;
    for(const count of [100,500,1000]){
      const rows=await this.history(groupId,count);
      if(!stillCurrent()||!Array.isArray(rows))return false;
      settlement=require('./coin-settlement.cjs').readSettlement(rows,options);
      if(settlement)break;
    }
    if(!settlement)return false;
    // Serialize the journal write with incoming routes and private clues.
    const save=this.queue.then(async()=>{
      if(!stillCurrent()||this.state.group(groupId)?.startedAt!==group.startedAt)return false;
      const result=await this.part2.append({session:group.session,view:group.self,text:settlement.text});
      if(!result?.ok)return false;
      if(!result.duplicate)artifact.addMessage(group.session,{id:result.id,view:group.self,type:'金币结算核验',text:settlement.text,private:false});
      this.state.setGroup(groupId,{coinSettlementRound:round});this.state.save();
      return true;
    });
    this.queue=save.catch(()=>{});
    return save;
  }

  async runInfer({ groupId, event, auto }) {
    if(auto&&this.state.group(groupId)?.soloPendingVerification){this.log('单机配置尚未核验，暂停自动行动');return;}
    const sessionId = `g${groupId}`;
    const reportIssue = async (text) => {
      const board = artifact.load(sessionId) || {};
      artifact.save(sessionId, {...board, execution: {at:new Date().toISOString(), status:'paused', message:text}});
      this.log(text);
    };
    if (this.inflight.get(sessionId)) {
      if (auto || !this.pending.get(sessionId)?.auto) this.pending.set(sessionId, { groupId, event, auto });
      if (!auto) await reportIssue('推理正在进行，稍后会自动补发结果。');
      return;
    }
    const matchCreatedAt = store.load(sessionId)?.meta?.createdAt;
    const confirmedSelf = this.state.group(groupId)?.self;
    const turnSnapshot = this.turns.get(String(groupId));
    const canAct = () => confirmedSelf != null && this.state.group(groupId)?.self === confirmedSelf && this.config.behavior.mode === "auto" && turnSnapshot && this.turns.get(String(groupId)) === turnSnapshot && !turnSnapshot.sent && !(this.state.group(groupId) || {}).ended && !this.state.group(groupId)?.soloPendingVerification;
    const recent = (this.inferTimes.get(sessionId) || []).filter((t) => Date.now() - t < 60000);
    if (auto && recent.length >= this.config.behavior.maxInferPerMinute) {
      if(!canAct())return;
      const delay=Math.max(100,60000-(Date.now()-Math.min(...recent))+100);
      this.scheduleInfer(sessionId,{groupId,event},delay);
      return reportIssue(`推理限流，约 ${Math.ceil(delay/1000)} 秒后自动继续当前回合。`);
    }
    this.inferTimes.set(sessionId, [...recent, Date.now()]);
    const job = (async () => {
      try {
        const started = Date.now();
        if(auto&&canAct()&&turnSnapshot.round===1&&!turnSnapshot.steps?.length){
          let ready=false;
          const openingDeadline=turnSnapshot.startedTime+8000;
          if(Date.now()<openingDeadline){
            let timer;
            try {
              ready=await Promise.race([
                this.ensureOpeningWalls(groupId,confirmedSelf,()=>canAct()&&Date.now()<openingDeadline),
                new Promise(resolve=>{timer=setTimeout(resolve,Math.max(0,openingDeadline-Date.now()),false);}),
              ]);
            }catch(error){this.log('开局四墙补读失败：'+error.message);}
            finally{clearTimeout(timer);}
          }
          if(!canAct())return;
          if(!ready){
            const remaining=openingDeadline-Date.now();
            if(remaining>0){
              this.scheduleInfer(sessionId,{groupId,event},Math.min(3000,remaining));
              return reportIssue('短暂等待本人开局四墙私聊。');
            }
            this.log('未收到本人开局四墙，保留未知墙状态并继续首步推理。');
          }
        }
        if(auto&&canAct()){
          if(turnSnapshot.round>1){
            let ready=false;
            try {ready=await this.ensurePreviousCoins(groupId,turnSnapshot,canAct);}
            catch(error){this.log('金币结算核验失败：'+error.message);}
            if(!canAct())return;
            if(!ready){
              this.scheduleInfer(sessionId,{groupId,event},2500);
              return reportIssue('等待核对上一回合金币公示与前后阶段，尚未发送本回合指令。');
            }
          }
          await this.reconcileHeartbeat(groupId,turnSnapshot,confirmedSelf,canAct);
          if(!canAct())return;
        }
        const inferenceBudget=()=>{
          const seconds=turnSnapshot?.feedback?.match(/(?:剩余时间|等待时间)\s*(\d+)\s*秒/)?.[1];
          const configured=this.config.behavior.inferBudgetMs||15000;
          if(!auto||!seconds||!turnSnapshot.promptTime)return configured;
          const remaining=turnSnapshot.promptTime+Number(seconds)*1000-Date.now();
          // A solve can use one budget per player, and QQ needs time for delivery.
          const players=store.load(sessionId)?.base?.config?.playerCount||2;
          return Math.max(1000,Math.min(configured,Math.floor((remaining-6000)/Math.max(2,players))));
        };
        let reportInput;
        const infer = () => {
          reportInput=JSON.stringify(store.load(sessionId));
          return this.part2.qq(sessionId, {
          budgetMs:inferenceBudget(),heartbeatPaddingRound:this.state.group(groupId)?.heartbeatPaddingRound
          });
        };
        let result = await infer();
        this.stats.inferred += 1;
        // Pool missing? Read the opening picture (or group history) and retry once,
        // instead of making the player paste the pool by hand.
        if ((!result || !result.ok) && result && result.code === 'NEED_POOL') {
          const journal = store.load(sessionId);
          const mode = journal && journal.base.config ? journal.base.config.mode : null;
          const recovered = await this.tryRecoverPool(groupId, mode);
          if (recovered && recovered.ok) {
            this.log(`NEED_POOL 自动补读区块池：${recovered.pool}`);
            result = await infer();
            this.stats.inferred += 1;
          }
        }
        if (!result || !result.ok) {
          if (result && result.code === 'NEED_POOL') {
            return reportIssue('还不能推理：自动读开局图没成功（可能没存到图，或识别置信度太低）。请检查开局图与后台日志。');
          }
          if (result && result.code === 'SPECTATOR') {
            return reportIssue('现在是观战视角：等待机器人行动提示确认本人编号。');
          }
          if (result && result.code === 'SESSION_NOT_FOUND') return reportIssue('没有对局记录：等机器人开局公告。');
          return reportIssue(`推理失败：${(result && result.message) || '未知错误'}`);
        }
        if (matchCreatedAt !== store.load(sessionId)?.meta?.createdAt) return;
        if (confirmedSelf !== this.state.group(groupId)?.self) return;
        if (!auto && this.state.group(groupId)?.ended) return;
        if (auto && (!turnSnapshot || this.turns.get(String(groupId)) !== turnSnapshot || (this.state.group(groupId) || {}).ended)) return;
        const currentBoardInput=()=>reportInput===JSON.stringify(store.load(sessionId));
        if(!currentBoardInput()){
          this.scheduleInfer(sessionId,{groupId,event},100);
          return;
        }
        const saved = result.report && artifact.setReport(sessionId, { ...result.report, text: result.qqText });
        if (!auto) return; // Background all-player inference never sends an action.
        if (auto && this.config.behavior.autoMove !== false) {
          const ch = result.report?.self === confirmedSelf ? this.moveChar(result.report) : null;
          if (ch && canAct()) {
            if (turnSnapshot.recovered) {
              const history=(await this.history(groupId,100)).slice().sort((a,b)=>Number(a.time)-Number(b.time));
              const latest=this.recoveryPrompt(history,this.state.group(groupId)?.gameBotId);
              if(!latest || String(latest.event.message_id)!==turnSnapshot.promptId) return reportIssue('恢复时行动提示已变化，等待最新反馈。');
            }
            const tactic=result.report.suggestion.tactic;
            let command=require('../night-strategist/batch-command.cjs').batchCommand(result.report,ch,turnSnapshot.round,turnSnapshot.steps.length);
            if(tactic?.kind==='bayes-exploration'&&tactic.confirmedPrefix){
              if(!turnSnapshot.promptId||tactic.round!==turnSnapshot.round||tactic.steps!==turnSnapshot.steps.length||
                !/^[上下左右]{2,3}$/.test(tactic.command)||tactic.command[0]!==ch||
                tactic.command!==result.report.suggestion.bayes?.options?.[0]?.command)return reportIssue('探路计划与当前步数不符，等待重新核验。');
              command=tactic.command;
            }
            const heartbeat=tactic?.kind==='heartbeat-align';
            if(heartbeat){
              command=require('../night-strategist/heartbeat.cjs').heartbeatCommand(tactic,turnSnapshot.round,turnSnapshot.steps.length,ch,this.state.group(groupId)?.heartbeatPaddingRound);
              if(!turnSnapshot.promptId||!command)return reportIssue('心跳垫步凭据和当前行动不符，等待重新核验。');
            }
            const target=result.report.suggestion.mode?.hidden?.active?'referee-private':'match-group';
            const request=decisionPolicy.requestFor({
              session:sessionId,journal:JSON.parse(reportInput),
              messages:artifact.load(sessionId)?.messages||[],self:confirmedSelf,
              round:turnSnapshot.round,step:turnSnapshot.steps.length+1,
              target,budgetMs:inferenceBudget()
            });
            const selected=await decisionPolicy.choose({policy:this.policy,request,proposed:command,retainedTarget:target});
            if(!selected)return reportIssue('决策器等待，未发送游戏动作。');
            if(this.policy&&heartbeat&&selected.text!==command)return reportIssue('心跳恢复动作不可替换。');
            command=selected.text;
            const sent=await this.speak(command, groupId, () => {
              if (!canAct()) return false;
              if(!currentBoardInput()){this.scheduleInfer(sessionId,{groupId,event},100);return false;}
              if(heartbeat&&this.state.group(groupId)?.heartbeatPaddingRound===turnSnapshot.round)return false;
              turnSnapshot.sent = true;
              if(turnSnapshot.promptId){
                this.state.setGroup(groupId,{
                  lastActionPromptId:turnSnapshot.promptId,actionAttemptAt:Date.now(),uncertainPromptId:null,
                  ...(heartbeat?{heartbeatPaddingRound:turnSnapshot.round}:{}),
                  pendingBatch:command.length>1&&command!=='停止'?{round:turnSnapshot.round,endStep:turnSnapshot.steps.length+command.length,commands:command}:null
                });
                this.state.save();
              }
              return true;
            }, {transport:selected.target==='referee-private'?'private':'group',decisionAt:saved?.decisions.at(-1)?.at,round:turnSnapshot.round,step:turnSnapshot.steps.length+1,
              purpose:require('../host.cjs').get('decision-report.cjs').purpose(result.report,turnSnapshot.round)});
            if(sent===false)return;
            const board = artifact.load(sessionId) || {};
            artifact.save(sessionId,{...board,execution:{at:new Date().toISOString(),status:'sent',message:'已向 LGTBot 发送方向：'+command}});
            this.log(`推理完成并自动落子 ${sessionId}: ${command}`);
            return;
          }
        }
        const text = result.qqText || renderFallback(result);
        this.log(`推理完成 ${sessionId} ${Date.now() - started}ms`);
        return reportIssue(result.report?.suggestion?.tactic?.kind === 'hold-first-round' ? '首轮尚未完成探索且没有合适方向，已保留阻挡保护。' : '本次未执行动作，原因与建议见推理报告。');
      } catch (error) {
        this.stats.errors += 1;
        this.log(`推理异常: ${error.message}`);
        if(auto&&turnSnapshot?.sent&&this.turns.get(String(groupId))===turnSnapshot&&/send_group_msg|Timeout|超时/.test(error.message)){
          this.state.setGroup(groupId,{uncertainPromptId:turnSnapshot.promptId});this.state.save();
          this.recoveryRequested=true;
          this.wakeRecovery?.();
          this.log('发送结果不确定，将核对历史后自动恢复，避免重复落子');
        }
        if(auto&&canAct()&&['EPERM','EACCES','EBUSY'].includes(error.code)){
          this.scheduleInfer(sessionId,{groupId,event},2000);
          this.log('文件暂时被占用，2 秒后重试当前未发送动作');
          return;
        }
        return reportIssue(`推理失败：${error.message}`);
      } finally {
        this.inflight.delete(sessionId);
        const pending = this.pending.get(sessionId);
        this.pending.delete(sessionId);
        if (pending) {
          setTimeout(() => { this.runInfer(pending).catch(() => {}); }, 200);
        }
      }
    })();
    this.inflight.set(sessionId, job);
    return job;
  }

  async showStatus({ groupId, event }) {
    const sessionId = `g${groupId}`;
    try {
      const result = await this.part2.status(sessionId);
      if (!result || !result.ok) return this.reply({ groupId, event, text: `读取状态失败：${(result && result.message) || '未知'}` });
      const s = result.status;
      const lines = [
        `对局：${s.modeName} ${s.players}人 ${s.size}×${s.size}${s.silent ? ' 静音' : ''}`,
        `消息 ${s.messages} 条 · 回合 ${s.rounds.join('/') || '—'} · 本人 ${s.self}号`,
        `区块池 ${s.poolCount} 块${s.poolSource === 'auto' ? '（经典/空旷/无声自动全池）' : s.poolReady ? '' : '（未录入，推理前需补）'}`,
      ];
      if (s.pendingRounds.length) lines.push(`待补本人四墙：第 ${s.pendingRounds.join('、')} 回合`);
      if (s.ambiguities) lines.push(`待定分支：${s.ambiguities} 处`);
      const group = this.state.group(groupId);
      if (group && group.openingImage) lines.push(`开局图：${path.basename(group.openingImage)}`);
      if (group && group.imagePool) lines.push(`读图区块池（${group.imagePoolConfidence || '?'}）：${group.imagePool}`);
      return this.reply({ groupId, event, text: lines.join('\n') });
    } catch (error) {
      return this.reply({ groupId, event, text: `读取状态失败：${error.message}` });
    }
  }

  async manualSettings({ groupId, event, body }) {
    const sessionId = `g${groupId}`;
    const pairs = body.split(/\s+/);
    const settings = {};
    for (const pair of pairs) {
      const [key, value] = pair.split(/[:：=]/);
      if (!value) continue;
      if (key === '模式') settings.mode = value;
      else if (key === '人数') settings.players = Number(value);
      else if (key === '本人') settings.self = Number(value);
      else if (key === '边长') settings.size = Number(value);
      else if (key === '出口') settings.exitCount = Number(value);
    }
    if (!Object.keys(settings).length) return this.reply({ groupId, event, text: '用法示例：设置 模式:经典 人数:4 本人:2 边长:9' });
    const result = await this.part2.init({ session: sessionId, settings: { ...settings, force: true }, meta: { group: groupId } });
    if (result && result.ok) {
      artifact.reset(sessionId);
      artifact.setSettings(sessionId, { mode: settings.mode, players: settings.players, size: settings.size, exitCount: settings.exitCount, group: String(groupId) });
      this.state.setGroup(groupId, { session: sessionId, self: settings.self ?? this.state.group(groupId).self });
      this.state.data.lastSession = sessionId;
      this.state.save();
      return this.reply({ groupId, event, text: '已按设置重建对局记录。' });
    }
    return this.reply({ groupId, event, text: `设置失败：${(result && result.message) || '未知'}` });
  }

  /* -------------------------------- replies ------------------------------ */

  async reply({ groupId, event, text }) {
    const target = event ? this.config.reply.to : 'group'; // autonomous posts always go to the group
    const segments = [];
    if (this.config.reply.quote && event && event.message_id != null) {
      segments.push({ type: 'reply', data: { id: String(event.message_id) } });
    }
    if (this.config.reply.atSender && event && event.user_id && String(event.user_id) !== this.selfId && target !== 'private') {
      segments.push({ type: 'at', data: { qq: String(event.user_id) } });
      segments.push({ type: 'text', data: { text: ' ' } });
    }
    segments.push({ type: 'text', data: { text: trim(text, this.config.reply.maxChars) } });
    await this.throttle(groupId);
    try {
      if (target === 'group' || target === 'both') await this.send({ type: 'group', groupId, message: segments });
      if (target === 'private' || target === 'both') await this.send({
        type: 'private',
        userId: event.user_id,
        groupId,
        message: segments.filter((s) => s.type === 'text'), // reply/at only make sense in the group
      });
      this.stats.replied += 1;
      this.recent.unshift({ at: new Date().toISOString(), groupId: String(groupId), target, text: trim(text, 500) });
      if (this.recent.length > 20) this.recent.length = 20;
    } catch (error) {
      this.stats.errors += 1;
      this.log(`发送失败: ${error.message}`);
    }
  }

  async throttle(groupId) {
    const wait = Math.max(0, (this.lastSend.get(groupId) || 0) + this.config.reply.throttleMs - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastSend.set(groupId, Date.now());
  }

  async appendOwnNames(names) {
    for (const name of names) if (name) this.selfNames.add(String(name));
  }

  /** Our own group messages carry the exact card/nickname the game bot sees. */
  recordSelfName(event) {
    const sender = event.sender || {};
    for (const name of [sender.card, sender.nickname]) if (name) this.selfNames.add(String(name).trim());
  }
}

/** Flatten QQ markdown to plain text: drop images, turn mention links into @name. */
function markdownText(content) {
  return String(content || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\(mqqapi:\/\/[^)]*\)/g, '@$1')
    .replace(/\[\]\([^)]*\)/g, '')
    .trim();
}

/** Image URLs inside QQ markdown (LGTBot puts the block sheet there). */
function markdownImages(content) {
  const text = String(content || '');
  const out = [];
  for (const match of text.matchAll(/!\[[^\]]*\]\(((?:https?:\/\/|data:)[^)\s]+)\)/g)) out.push({ url: match[1] });
  for (const match of text.matchAll(/<img[^>]+src="([^"]+)"/g)) out.push({ url: match[1] });
  return out;
}

function journalSize(sessionId) {
  try {
    const journal = store.load(sessionId);
    return journal && journal.base && journal.base.config ? journal.base.config.size : null;
  } catch {
    return null;
  }
}

function normalize(text) {
  return String(text || '').replace(/\r/g, '').replace(/\[图片\]/g, '').trim();
}

function trim(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…';
}

function renderFallback(result) {
  const suggestion = result && result.report && result.report.suggestion;
  if (suggestion && suggestion.primary) return `建议${suggestion.primary.arrow}${suggestion.primary.label}`;
  return '暂时没有可用建议。';
}

const HELP = [
  '宽松：加入后自动参赛。',
  '#宽松 加入｜#宽松 退出｜#宽松 战绩｜#宽松 帮助',
  '管理员：#宽松 单机 [游戏] [参数]、#宽松 重置',
  supportedGames.help(),
].join('\n');

module.exports = { LongNightBot, StateStore, HELP };
