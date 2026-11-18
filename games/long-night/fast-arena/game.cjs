'use strict';
const K=require('../night-strategist/kernel.cjs'),{suggest}=require('../night-strategist/suggest.cjs'),{Engine}=require('./engine.cjs');
const modes={CLASSIC:'经典',TWIST:'幻变',WILD:'狂野',CRAZY:'疯狂',BUTTON:'按钮',TRAP:'陷阱',OPEN:'空旷',SILENT:'无声'};
const events={NONE:'无',RAINSTORY:'雨天小故事',LAZYGARDENER:'怠惰的园丁',OVERGROWTH:'营养过剩',AMBUSH:'十面埋伏'};
function validateScenario(s){
 if(!modes[s.mode]||!Number.isInteger(s.players)||s.players<2||s.players>8||![9,10,11,12].includes(s.size??9)||!events[s.event??'NONE']||!['PREVIOUS','NEXT'].includes(s.target??'PREVIOUS'))throw Error('unsupported scenario');
 if(!Number.isInteger(s.rounds??6)||(s.rounds??6)<3||(s.rounds??6)>40)throw Error('rounds must be 3..40');
 for(const k of Object.keys(s))if(!['mode','players','size','event','target','silent','rounds','dark','brawl','pointCapture','deliberate','bombs','boss','hidden','stopInfo','expandedPool','portalChaos'].includes(k))throw Error('unsupported scenario option: '+k);
 for(const k of ['silent','dark','brawl','pointCapture','deliberate','expandedPool','portalChaos'])if(s[k]!=null&&typeof s[k]!=='boolean')throw Error(k+' must be boolean');
 if(s.bombs!=null&&(!Number.isInteger(s.bombs)||s.bombs<0||s.bombs>3))throw Error('bombs must be 0..3');
 if(s.boss!=null&&(!Array.isArray(s.boss)||s.boss.some(b=>!['米诺陶斯','邦邦','暴君'].includes(b))))throw Error('invalid boss');
 if(s.hidden!=null&&!['关闭','回合','单步'].includes(s.hidden))throw Error('invalid hidden');
 if(s.stopInfo!=null&&!['无','私信','公开'].includes(s.stopInfo))throw Error('invalid stopInfo');
}
function options(s){validateScenario(s);return [`模式 ${modes[s.mode]}`,`边长 ${s.size??9}`,`回合数 ${s.rounds??6}`,`特殊事件 ${events[s.event??'NONE']}`,`捕捉目标 ${s.target==='NEXT'?'下家':'上家'}`,
 ...[['silent','静音'],['dark','摸黑'],['brawl','大乱斗'],['pointCapture','点杀'],['deliberate','谋定后动'],['expandedPool','拓展'],['portalChaos','传送紊乱']].map(([k,n])=>`${n} ${(s[k]??(k==='pointCapture'))?'开启':'关闭'}`),
 `炸弹 ${s.bombs??0}`,`BOSS ${s.boss?.length?s.boss.join(' '):'无'}`,`隐匿 ${s.hidden??'关闭'}`,`停止信息 ${s.stopInfo??'无'}`];}
function policyConfig(s,pool){return {...s,pool:pool.join(' '),pointCapture:s.pointCapture??true,captureTarget:s.target??'PREVIOUS',roomRules:{炸弹:s.bombs??0,BOSS:s.boss?.join(' ')||'无',隐匿:s.hidden??'关闭',停止信息:s.stopInfo??'无'}};}
function normalizeRefereeText(text,players){
 // Native At(pid) renders @0, unlike the seat headings consumed by M.parse.
 // Only the explicit public settlement format supplies a proved identity.
 if(!/(?:^|\n)【金币公示】(?:\r?\n|$)/.test(text))return text;
 return text.replace(/^@(\d+)(\s+获得了\s+[1-9]\d*\s+枚金币（当前共持有\s+\d+\s+枚）\s*)$/gm,
  (line,id,body)=>Number(id)<players?'['+Number(id)+'号]'+body:line);
}
function feed(journals,response,actionRound,actor,actionClock=null){
 for(const msg of response.messages){
  // The referee sees every private message; each policy gets only its own.
  for(let pid=0;pid<journals.length;pid++){
   if(msg.to!==-1&&msg.to!==pid)continue;
   if(/\[第\s*\d+\s*步\]/.test(msg.text)&&pid!==actor)continue;
   const normalized=normalizeRefereeText(msg.text,journals.length);
   let text=normalized.replace(/\[(\d+)号\]正在行动中/g,'[$1号]玩家正在行动中');
   if(!/【第\s*\d+\s*回合】/.test(text)&&!text.includes('【开局】'))text=`【第 ${msg.round||actionRound||response.round} 回合】\n`+text;
   if(/\[第\s*\d+\s*步\]/.test(text))text=text.replace(/(\[第\s*\d+\s*步\])/,'@@PLAYER_'+actor+'\n$1');
   // A single referee request identifies the arrival even when a private DM
   // flushes before its public step result. Never guess a step for batches.
   const clock=actionClock&&msg.to===actor&&pid===actor;
   const source=clock||normalized!==msg.text?{kind:'local-referee',
    ...(clock?{actionClock:{...actionClock,player:actor}}:{}),
    ...(normalized!==msg.text?{nativeText:msg.text,normalization:'public-coin-seat-v1'}:{})}:undefined;
   const j=journals[pid];j.messages.push({id:'m'+(j.messages.length+1),text,view:pid,receiverConfirmed:true,...(source?{source}:{})});
  }
 }
}
async function play({engine:providedEngine,scenario,seed,seats,budgetMs=40,maxActions=600,maxTurnSteps=30,onStep,auditProfiles=[]}){
 validateScenario(scenario);if(seats.length!==scenario.players)throw Error('seat count mismatch');
 const engine=providedEngine||new Engine(),journals=[],actions=[],behaviorAudit=[],truthTimeline=[];let state;
 const retainTruth=()=>{if(state.truth)truthTimeline.push({afterActions:actions.length,round:state.round,actor:state.actor,step:state.step,over:state.over,truth:state.truth,messages:state.messages});};
 const paddingRounds=new Map();
 try{
  state=await engine.request({op:'init',seed,players:scenario.players,options:options(scenario),audit:true});
  retainTruth();
  for(let pid=0;pid<scenario.players;pid++){
   let j=K.configure(K.newJournal(),policyConfig(scenario,state.pool));
   j.base.target=scenario.target??'PREVIOUS';j.view=pid;
   j.meta={...j.meta,openingSeed:`arena:${seed}:seat:${pid}`};
   j.messages=[{id:'m1',text:'我是'+pid+'号',view:pid,receiverConfirmed:true}];journals.push(j);
  }
  feed(journals,state,1,0);
  while(!state.over&&actions.length<maxActions){
   const actor=state.actor,round=state.round,profile=seats[actor],start=Date.now();
   // clone the information set; policies never receive native state or others' journals.
   const journal=journals[actor];
   let inferred=await K.infer(journal,{budgetMs,deadline:Date.now()+budgetMs});
   const timings={inferenceMs:Date.now()-start};const decisionStart=Date.now();
   const heartbeatPaddingRound=paddingRounds.get(actor);
   let decision=suggest({journal,...inferred,heartbeatPaddingRound,decisionBudgetMs:budgetMs,experiment:profile.params});
   timings.decisionMs=Date.now()-decisionStart;
   const invalid=s=>!s.primary||s.primary.blocked&&!s.primary.intentionalCollision||s.warnings?.some(w=>/矛盾|冲突/.test(w));
   let retried=false;
   if((invalid(decision)||decision.tactic?.kind==='required-transit')&&budgetMs<500){
    retried=true;const retryStart=Date.now();
    const retry=await K.infer(journal,{budgetMs:500,deadline:Date.now()+500});
    const refined=suggest({journal,...retry,heartbeatPaddingRound,decisionBudgetMs:budgetMs,experiment:profile.params});
    // Refinement may spend its budget before reaching the known local map.
    // Preserve the already legal retreat instead of replacing it with null.
    timings.retryMs=Date.now()-retryStart;
    if(!invalid(refined)||invalid(decision)){decision=refined;inferred=retry;}
   }
   // Same information and random seed, only parameters vary. Never execute shadow choices.
   if(auditProfiles.length&&actions.length%5===0&&behaviorAudit.length<32){
    const choices=auditProfiles.map(p=>{
     const s=suggest({...structuredClone({journal,...inferred}),heartbeatPaddingRound,decisionBudgetMs:budgetMs,experiment:p.params});
     return {profile:p.id,direction:s.primary?.direction??null,tactic:s.tactic?.kind??'ordinary',score:s.primary?.score??null};
    });
    behaviorAudit.push({actor,round,step:state.step,choices});
   }
   let action={up:'上',down:'下',left:'左',right:'右',stop:'停止'}[decision.primary?.direction];
   let fallback=null;
   const plan=decision.tactic;
   action=require('../night-strategist/batch-command.cjs').batchCommand({self:actor,board:inferred.board,suggestion:decision},action,round,state.step);
   if(plan?.kind==='heartbeat-align'){
    action=require('../night-strategist/heartbeat.cjs').heartbeatCommand(plan,round,state.step,action,heartbeatPaddingRound);
   }
   if(state.step>=maxTurnSteps){actions.push({actor,round,step:state.step,fallback:'turn-step-cap'});break;}
   if(!action||invalid(decision)){action='超时';fallback='policy-timeout';}
   const entry={actor,round,step:state.step,messageCount:journal.messages.length,profile:profile.id,action,fallback,retried,timings,elapsedMs:Date.now()-start,decision};actions.push(entry);
   const actionClock=!fallback&&/^[上下左右]$/.test(action)?{round,step:state.step+1}:null;
   state=await engine.request({op:fallback?'timeout':'act',player:actor,action});retainTruth();feed(journals,state,round,actor,actionClock);
   if(plan?.kind==='heartbeat-align'&&!fallback)paddingRounds.set(actor,round);
   if(onStep)onStep(entry,{journals,actions,truthTimeline});
  }
  const terminationReason=state.over?null:actions.at(-1)?.fallback==='turn-step-cap'?'turn-step-cap':'game-action-cap';
  return {version:2,scenario,seed,seats:seats.map(x=>x.id),profiles:seats,complete:state.over,truncated:!state.over,terminationReason,scores:state.scores??null,out:state.out??null,rounds:state.round,actions,journals,behaviorAudit,truthTimeline};
 }finally{if(!providedEngine)engine.close();}
}
module.exports={play,feed,options,validateScenario,policyConfig,modes,normalizeRefereeText};
