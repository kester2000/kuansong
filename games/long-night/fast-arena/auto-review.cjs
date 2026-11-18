'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
function json(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2));}
function review(run){
 const manifest=JSON.parse(fs.readFileSync(path.join(run,'manifest.json'))),report=JSON.parse(fs.readFileSync(path.join(run,'report.json'))),base=path.join(run,'review');fs.mkdirSync(base,{recursive:true});
 const findings=[];
 for(const result of report.results){
  const dir=path.join(base,String(result.id));fs.mkdirSync(dir,{recursive:true});
  const complete=path.join(run,'games',result.id+'.json.gz'),checkpoint=path.join(run,'games',result.id+'.checkpoint.json.gz');
  const file=fs.existsSync(complete)?complete:fs.existsSync(checkpoint)?checkpoint:null;
  const incomplete=result.complete!==true;
  json(path.join(dir,'source-manifest.json'),{kind:'local-selfplay',result,scenario:manifest.scenario,policy:manifest.policy,hashes:manifest.hashes,source:manifest.source,evidence:file,partial:incomplete||file!==complete});
  const gaps=['缺完整真图与真状态时间线','未完成逐节点新旧策略与替代动作反事实对照','合成对局，无人类参赛或群聊'];
  const unfinished=incomplete?{game:result.id,kind:'incomplete-game',reason:result.reason||result.error||'unknown'}:null;
  if(unfinished){findings.push(unfinished);gaps.push('本局未正常结算，不计入有效结算样本');}
  if(!file){gaps.push('无全玩家观测，仅保留动作日志');findings.push({game:result.id,kind:'missing-journal',reason:result.reason});}
  else{
   const game=JSON.parse(zlib.gunzipSync(fs.readFileSync(file))),selected=[];
   if(game.truthTimeline?.length){
    json(path.join(dir,'truth-timeline.json'),{kind:'referee-truth-only',granularity:'referee-request-boundary',snapshots:game.truthTimeline});
    gaps[0]='已保存初始图及每条裁判请求后的地图/玩家真状态；批量指令内部逐步状态与 BOSS 状态仍需重放核验';
   }
   // A saved .json.gz can be an action-cap truncation, not a completed game.
   // Attach the last available decision prefix without inventing missing data.
   const lastIndex=game.actions.findLastIndex(a=>Number.isInteger(a.messageCount));
   if(unfinished&&lastIndex>=0){const a=game.actions[lastIndex];Object.assign(unfinished,{actor:a.actor,index:lastIndex,messageCount:a.messageCount});}
   for(let actor=0;actor<game.journals.length;actor++){
    const j=game.journals[actor],p=path.join(dir,'player-'+actor);fs.mkdirSync(p,{recursive:true});
    fs.writeFileSync(path.join(p,'observations.jsonl'),j.messages.map((m,i)=>JSON.stringify({...m,index:i,evidence:'observed',origin:'local-referee',recipient:actor})).join('\n')+'\n');
    const own=game.actions.map((a,index)=>({...a,index})).filter(a=>a.actor===actor);
    for(let i=0;i<own.length;i++){
     const a=own[i],slow=a.elapsedMs>1000,repeated=i>=7&&own.slice(i-7,i+1).every(b=>b.round===a.round&&b.action===a.action);
     if(i===0||i===own.length-1||unfinished&&a.index===lastIndex||a.fallback||slow||repeated){
      selected.push({actor,index:a.index,round:a.round,step:a.step,messageCount:a.messageCount,action:a.action,fallback:a.fallback,elapsedMs:a.elapsedMs,timings:a.timings,reason:unfinished&&a.index===lastIndex?'incomplete-game':a.fallback||slow&&'slow-decision'||repeated&&'repeated-direction'||'player-coverage',comparisonStatus:'pending'});
      if(a.fallback||slow||repeated)findings.push({game:result.id,actor,index:a.index,messageCount:a.messageCount,kind:a.fallback||slow&&'slow-decision'||'repeated-direction',elapsedMs:a.elapsedMs,timings:a.timings});
     }
    }
   }
   fs.writeFileSync(path.join(dir,'selected-prefixes.jsonl'),selected.map(x=>JSON.stringify(x)).join('\n')+'\n');
   json(path.join(dir,'learning-items.json'),{status:'证据不足待验证',items:findings.filter(f=>f.game===result.id),note:'重复方向只是排查线索，不等同于循环；慢决策不等同于错误。不得由筛查自动修改策略。'});
  }
  json(path.join(dir,'discussion-evidence.json'),{applicable:false,reason:'纯本机机器自对抗，无群聊或人类讨论'});
  fs.writeFileSync(path.join(dir,'review.txt'),`状态：初审；策略待验证；未部署。\n结果：${JSON.stringify(result)}\n缺口：${gaps.join('；')}\n每位玩家的原始观测单独保存。选择动作时仅允许消息索引小于 messageCount 的观测。selected-prefixes 不是已完成的策略对照。\n`);
 }
 const summary={status:'初审',run,scenario:manifest.scenario,completed:report.completed,cleanCompleted:report.cleanCompleted,failed:report.failed,truncated:report.truncated,timeouts:report.timeouts,findings};json(path.join(base,'summary.json'),summary);return summary;
}
if(require.main===module)console.log(JSON.stringify(review(path.resolve(process.argv[2]))));
module.exports={review};
