'use strict';
// Post-game structural triage for all scheduled modes (user authorized).
// Truth is used only to flag suspicious games, never to select a policy action.
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),crypto=require('node:crypto');
const VERSION=4,read=(p,fallback)=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):fallback;
const save=(p,v)=>{fs.writeFileSync(p+'.tmp',JSON.stringify(v,null,2)+'\n');fs.renameSync(p+'.tmp',p);};
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const done=status=>['complete','no-completed-games','coarse-complete','mixed-complete'].includes(status);
function eligible(s){return s?.mode==='TWIST'&&s.players===2&&(s.size??9)===9&&(s.event??'NONE')==='NONE'
 &&!['silent','deliberate','dark','brawl','expandedPool','portalChaos'].some(k=>s[k])
 &&s.pointCapture!==false&&!(s.bombs>0)&&!s.boss?.length&&(s.hidden??'关闭')==='关闭'&&(s.stopInfo??'无')==='无';}
// All scheduled modes get structural triage. `eligible` remains the stricter
// predicate for old ordinary-TWIST duplicate scheduling; do not broaden it.
function quickEligible(s){return ['TWIST','CLASSIC','SILENT'].includes(s?.mode)&&Number.isInteger(s.players)&&s.players>=2&&s.players<=8;}
function inspect(game,result,budgetMs,players=game?.journals?.length||2){
 const flags=[],notes=[],add=(kind,index,actor,detail)=>{if(!flags.some(f=>f.kind===kind&&f.actor===actor))flags.push({kind,index,actor,detail});};
 if(!result.complete||result.truncated||result.failed||game?.complete!==true)add('incomplete-game',null,null,result.reason||result.error||game?.terminationReason);
 if(!game)return {status:'needs-detail',flags:[...flags,{kind:'missing-journal'}],notes};
 const rawActions=game.actions||[],timeline=game.truthTimeline||[],journals=game.journals||[];
 const capped=!result.complete&&game.complete!==true&&(result.reason||game.terminationReason)==='turn-step-cap'
  &&rawActions.at(-1)?.fallback==='turn-step-cap'&&rawActions.at(-1)?.action===undefined&&rawActions.at(-1)?.messageCount===undefined;
 const actions=capped?rawActions.slice(0,-1):rawActions;
 if(capped)notes.push({kind:'supervisor-cap-marker',index:rawActions.length-1,note:'Not a sent command or missing decision observation'});
 if(journals.length!==players||journals.some(j=>!j.messages?.length)||timeline.length!==actions.length+1||result.complete&&!timeline.at(-1)?.over)add('incomplete-evidence');
 if(result.complete||result.scores!=null){if(!Array.isArray(result.scores)||result.scores.length!==players||result.scores.some((s,i)=>!Number.isFinite(s)||s!==timeline.at(-1)?.truth?.players?.[i]?.score))add('settlement-mismatch');}
 else notes.push({kind:'unfinished-without-settlement',note:'No result exists; excluded from completed games, not a mismatched result'});
 const seen=Array.from({length:players},()=>new Set()),stall=Array(players).fill(0),blockedTurns=Array(players).fill(null),covered=Array(players).fill(0),previousCount=Array(players).fill(0);let slowWithinBudget=0;
 for(const [index,a]of actions.entries()){
  const actor=a.actor;if(!Number.isInteger(actor)||actor<0||actor>=players){add('invalid-actor',index,actor);continue;}covered[actor]++;
  if(!Number.isInteger(a.messageCount)||a.messageCount<previousCount[actor]||a.messageCount>journals[actor]?.messages?.length)add('invalid-observation-boundary',index,actor);previousCount[actor]=a.messageCount;
  if(a.fallback)add(a.fallback,index,actor);
  if(!/^(?:[上下左右]+|停止)$/.test(a.action||'')&&!(a.action==='超时'&&a.fallback==='policy-timeout'))add('invalid-command',index,actor);
  if(a.decision?.warnings?.some(w=>/矛盾|冲突/.test(w)))add('decision-conflict',index,actor);
  const limit=Math.max(2000,Number(budgetMs)*1.5+500);if(a.elapsedMs>limit)add('decision-over-budget',index,actor,{elapsedMs:a.elapsedMs,budgetMs,limit});else if(a.elapsedMs>1000)slowWithinBudget++;
  const t=a.decision?.tactic,batch=t?.kind==='escape'?t.batchEscape:t?.kind==='pursue'?t.batchCapture:null;
  const proof=t?.batchRoute||batch;if(proof?.confirmed&&proof.commands?.length>1&&t.round===a.round&&t.steps===a.step&&a.action?.length===1&&proof.commands.startsWith(a.action))add('confirmed-route-sent-single-step',index,actor,{kind:t.kind,commands:proof.commands});
  if(t?.rating?.equal&&t.kind==='pursue'&&t.batchCapture?.commands?.length>t.batchEscape?.commands?.length)add('rating-shorter-escape-unselected',index,actor);
  const before=timeline[index]?.truth?.players?.[actor],after=timeline[index+1]?.truth?.players?.[actor];
  if(!before||!after){add('missing-player-state',index,actor);continue;}
  const key=p=>[p.x,p.y,p.subspace].join(',');seen[actor].add(key(before));
  const moved=key(after)!==key(before),fresh=!seen[actor].has(key(after)),gain=after.score!==before.score;
  // A wall hit does not move, so the ordinary exploration counter misses a
  // policy that spends every turn retrying the same blocked first command.
  // Deliberate endings remain legitimate; this is a diagnostic, not a rule
  // that exposes truth coordinates to the action policy.
  const end=timeline[index+1],intentional=['trapped-finish','finish-capture','finish-exploration','portal-heartbeat-wait'].includes(t?.kind);
  if(a.step===0&&/^[上下左右]$/.test(a.action||'')&&!moved&&!gain&&!a.fallback&&!intentional&&(end?.over||end?.actor!==actor)){
   const signature=key(before)+':'+a.action,previous=blockedTurns[actor];
   const count=previous?.signature===signature&&a.round===previous.round+1?previous.count+1:1;
   blockedTurns[actor]={signature,round:a.round,count};
   if(count>=3)add('repeated-blocked-turn',index,actor,{consecutiveTurns:count,command:a.action,note:'Repeated ineffective first command across rounds; inspect observations, dynamic doors and available alternatives'});
  }else blockedTurns[actor]=null;
  if(fresh||gain)stall[actor]=0;else if(moved)stall[actor]++;
  seen[actor].add(key(after));
  // A score cap alone is not a loop: every genuinely new position resets it.
  if(stall[actor]>=12)add('repeated-exploration',index,actor,{consecutiveOldStateMoves:stall[actor],note:'Suspicious post-game movement, not proof the route was known to the player'});
 }
 // A first-turn escape can finish a two-player game before the other seat
 // ever gets control. Exempt it only with a complete, ordered referee trace.
 const orderedTurns=game.complete===true&&result.complete===true&&!result.truncated&&!result.failed
  &&actions.length>0&&timeline.length===actions.length+1
  &&timeline.every((t,i)=>t.afterActions===i&&t.over===(i===actions.length)
   &&(i===actions.length||Number.isInteger(t.actor)&&t.actor>=0&&t.actor<players&&t.actor===actions[i].actor));
 for(const [actor,count]of covered.entries())if(!count){
  if(orderedTurns&&journals[actor]?.messages?.length&&timeline.slice(0,-1).every(t=>t.actor!==actor))
   notes.push({kind:'game-ended-before-seat-turn',actor,observations:journals[actor].messages.length});
  else add('missing-seat-actions',undefined,actor);
 }
 if(slowWithinBudget)notes.push({kind:'slow-but-within-budget',count:slowWithinBudget,budgetMs});
 return {status:flags.length?'needs-detail':'coarse-pass',flags,notes,coverage:covered.map((actions,actor)=>({actor,actions,observations:journals[actor]?.messages?.length||0})),limits:'Coarse triage only; no full inference replay, human comparison or complete strategy proof'};
}
function record(root,item){
 const ledger=path.join(root,'reviews',item.id+'.json'),prior=read(ledger,{});
 if(done(prior.status)&&prior.status!=='coarse-complete')return {skipped:prior.status};
 const manifestPath=path.join(item.dir,'manifest.json'),reportPath=path.join(item.dir,'report.json'),manifest=read(manifestPath,{}),report=read(reportPath,{});
 if(!quickEligible(manifest.scenario))return {skipped:'unsupported-scenario'};
 if(!Array.isArray(report.results)||report.status==='running'||report.finished!==report.requested)return {skipped:'unsealed-report'};
 const files=report.results.map(r=>{const complete=path.join(item.dir,'games',r.id+'.json.gz'),checkpoint=path.join(item.dir,'games',r.id+'.checkpoint.json.gz');return fs.existsSync(complete)?complete:fs.existsSync(checkpoint)?checkpoint:null;});
 const signature=digest(JSON.stringify([VERSION,fs.readFileSync(manifestPath,'utf8'),fs.readFileSync(reportPath,'utf8'),files.map(f=>f?[path.basename(f),fs.statSync(f).size,fs.statSync(f).mtimeMs]:null)]));
 const target=path.join(root,'coarse-reviews',item.id+'.json'),cached=read(target,null);if(cached?.signature===signature)return {...cached,cached:true};
 const games=report.results.map((result,i)=>{let game=null,error=null;try{if(files[i])game=JSON.parse(z.gunzipSync(fs.readFileSync(files[i])));}catch(e){error=e.message;}const review=inspect(game,result,manifest.budgetMs,manifest.scenario.players);if(error)review.flags.push({kind:'unreadable-evidence',detail:error});return {id:result.id,seed:result.seed,complete:result.complete===true,evidence:files[i],sha256:files[i]?digest(fs.readFileSync(files[i])):null,...review};});
 const value={version:VERSION,signature,batch:item.id,checkedAt:new Date().toISOString(),policyRevision:manifest.revision,kind:'coarse-review',status:games.every(g=>g.status==='coarse-pass')?'coarse-complete':'needs-detail',games,coarsePassed:games.filter(g=>g.status==='coarse-pass').length,detailRequired:games.filter(g=>g.status==='needs-detail').length,fullReviewComplete:false,authorization:'User2026-11-16: all normally finished scheduled modes may be rapidly checked; anomalies diagnosed immediately',note:'Coarse passes leave the detailed queue; preserved raw evidence may reopen review. Not a complete all-seat counterfactual review.'};
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.mkdirSync(path.dirname(ledger),{recursive:true});
 if(cached){const history=path.join(path.dirname(target),'history',item.id+'.'+cached.signature+'.json');fs.mkdirSync(path.dirname(history),{recursive:true});if(!fs.existsSync(history))save(history,cached);}
 save(target,value);save(ledger,{...prior,...(prior.status&&!['coarse-complete','needs-detail'].includes(prior.status)?{previousManualStatus:prior.status}:{}),...value});return value;
}
function sweep(root){const index=readLines(path.join(root,'batches.jsonl')),results=[];for(const item of [...new Map(index.map(b=>[b.id,b])).values()]){try{results.push({batch:item.id,...record(root,item)});}catch(e){results.push({batch:item.id,error:e.message});}}return {checkedAt:new Date().toISOString(),results,coarsePassed:results.reduce((n,r)=>n+(r.coarsePassed||0),0),detailRequired:results.reduce((n,r)=>n+(r.detailRequired||0),0)};}
function readLines(file){return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}
module.exports={VERSION,eligible,quickEligible,inspect,record,sweep,done};
if(require.main===module){const result=sweep(process.argv[2]||path.resolve(__dirname,'../../../private/data/arena-runs/continuous'));console.log(JSON.stringify(result,null,2));if(result.results.some(r=>r.error))process.exitCode=1;}
