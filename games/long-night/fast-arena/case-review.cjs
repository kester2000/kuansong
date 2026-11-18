'use strict';
// Per-game anomaly diagnosis, distinct from coarse passes and full reviews.
// Recurring findings remain OPEN strategy issues even after this game is read.
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),crypto=require('node:crypto');
const VERSION=1,read=(p,f)=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):f;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const signature=g=>hash(JSON.stringify([g.id,g.status,g.complete,g.sha256,g.flags]));
function diagnose(game,result,coarse,budgetMs){
 if(!game||budgetMs!==500||!coarse.sha256||!coarse.flags?.length)return null;
 const kinds=[...new Set(coarse.flags.map(f=>f.kind))];
 if(kinds.some(k=>!['repeated-exploration','incomplete-game'].includes(k)))return null;
 const reason=result.reason||game.terminationReason;
 if(!result.complete&&!['turn-step-cap','game-action-cap','game-wall-time-cap'].includes(reason))return null;
 const raw=game.actions||[],marker=reason==='turn-step-cap'&&raw.at(-1)?.fallback==='turn-step-cap'&&!raw.at(-1)?.action;
 const actions=marker?raw.slice(0,-1):raw,timeline=game.truthTimeline||[],journals=game.journals||[];
 if(timeline.length!==actions.length+1||!actions.length||!journals.length)return null;
 if(!timeline.every((t,i)=>t.afterActions===i&&(i===actions.length||t.actor===actions[i].actor)))return null;
 if(actions.some(a=>a.fallback||!Number.isInteger(a.messageCount)||!journals[a.actor]?.messages||a.messageCount>journals[a.actor].messages.length))return null;
 const seats=journals.map((j,actor)=>{
  const own=actions.map((a,index)=>({...a,index})).filter(a=>a.actor===actor),flags=coarse.flags.filter(f=>f.actor===actor);
  return {actor,observations:j.messages.length,actions:own.length,maxDecisionMs:Math.max(0,...own.map(a=>a.elapsedMs||0)),firstDecision:own[0]?.index,lastDecision:own.at(-1)?.index,
   findings:flags.map(f=>{const a=actions[f.index],start=Math.max(0,f.index-24);return {index:f.index,round:a?.round,step:a?.step,messageCount:a?.messageCount,
    observationHash:a?hash(JSON.stringify(j.messages.slice(0,a.messageCount))):null,action:a?.action,tactic:a?.decision?.tactic,warnings:a?.decision?.warnings,
    recentActualRoute:actions.map((x,index)=>({...x,index})).slice(start,f.index+1).filter(x=>x.actor===actor).map(x=>({index:x.index,round:x.round,step:x.step,action:x.action,position:timeline[x.index+1]?.truth?.players?.[actor]})),
    interpretation:'Repeated real positions without score gain. This alone does not prove the player knew its global position or had a better route.'};})};
 });
 const issues=[...(kinds.includes('repeated-exploration')?['short-budget-repeated-routes']:[]),...(!result.complete?['screening-run-cap']:[])];
 return {version:VERSION,status:'analyzed-open-issue',issues,seats,result:{complete:result.complete===true,reason,scores:result.scores??null},
  conclusion:result.complete?'Repeated route examined for every seat; no missing action, excess decision time or incorrect result detected. Strategy improvement remains open.':'Run stopped at its explicit limit while actions continued; it has no final result and remains excluded from completed games. Route improvement remains open.',
  fullReviewComplete:false,limits:'Focused diagnostic review, not all-seat counterfactual proof or a claim the strategy is fixed. Raw observations and truth are separated; truth never selects an action.'};
}
function record(root,item){
 const coarse=read(path.join(root,'coarse-reviews',item.id+'.json'),null);if(!coarse)return null;
 const report=read(path.join(item.dir,'report.json'),{}),manifest=read(path.join(item.dir,'manifest.json'),{}),target=path.join(root,'case-reviews',item.id+'.json'),old=read(target,{games:[]});
 const games=coarse.games.filter(g=>g.status==='needs-detail').flatMap(g=>{
  const previous=old.games.find(x=>x.id===g.id&&x.signature===signature(g));if(previous)return [previous];
  if(!g.evidence||!fs.existsSync(g.evidence))return [];
  const bytes=fs.readFileSync(g.evidence);if(hash(bytes)!==g.sha256)return [];
  const game=JSON.parse(z.gunzipSync(bytes)),result=report.results?.find(r=>r.id===g.id),d=result&&diagnose(game,result,g,manifest.budgetMs);
  return d?[{id:g.id,signature:signature(g),evidence:g.evidence,sha256:g.sha256,checkedAt:new Date().toISOString(),...d}]:[];
 });
 if(!games.length&&!old.games.length)return null;
 const next={batch:item.id,checkedAt:new Date().toISOString(),games};
 fs.mkdirSync(path.dirname(target),{recursive:true});
 if(fs.existsSync(target)&&JSON.stringify(old.games)!==JSON.stringify(games)){const dir=path.join(root,'case-reviews','history');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,item.id+'.'+hash(JSON.stringify(old))+'.json'),JSON.stringify(old,null,2)+'\n');}
 fs.writeFileSync(target+'.tmp',JSON.stringify(next,null,2)+'\n');fs.renameSync(target+'.tmp',target);return next;
}
function matching(root,batch,g){const r=read(path.join(root,'case-reviews',batch+'.json'),{games:[]});return r.games.find(x=>x.id===g.id&&x.signature===signature(g)&&x.status==='analyzed-open-issue');}
function sweep(root){const items=require('./continuous.cjs').loadIndex(root),results=[];for(const b of items)try{const r=record(root,b);if(r)results.push(r);}catch(e){results.push({batch:b.id,error:e.message});}return results;}
module.exports={VERSION,signature,diagnose,record,matching,sweep};
if(require.main===module){const rows=sweep(process.argv[2]||path.resolve(__dirname,'../../../private/data/arena-runs/continuous'));console.log(JSON.stringify({batches:rows.length,games:rows.reduce((n,r)=>n+(r.games?.length||0),0),errors:rows.filter(r=>r.error)}));}
