'use strict';
// Scheduling only: never changes review conclusions or deletes game evidence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {read,save,loadIndex,pending,DEFAULT_ROOT}=require('./continuous.cjs');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const signature=g=>digest([g.id,g.status,g.complete,g.sha256,g.flags]);
function policyEntries(tree){return tree.split('\n').filter(line=>{const file=line.split('\t')[1]||'';
 return /\.(?:[cm]?js|json)$/.test(file)&&!/(?:^|\/)(?:__tests__|tests?)(?:\/|$)/.test(file)&&! /\.(?:test|spec)\.[cm]?js$/.test(file);
});}
function policyId(repo,revision){
 const entries=policyEntries(cp.execFileSync('git',['-C',repo,'ls-tree','-r',revision,'--','night-strategist','runtime','vendor','fast-arena/game.cjs','fast-arena/worker.cjs','fast-arena/engine.cjs'],{encoding:'utf8'}));
 if(!entries.length)throw Error('No strategy sources in revision '+revision);return digest(entries);
}
function candidates(root,items){return pending(root,[...new Map(items.map(b=>[b.id,b])).values()]).map(b=>{
 const r=read(path.join(root,'reviews',b.id+'.json'),{});
 return {...b,review:r,detailGames:Array.isArray(r.games)?r.games.filter(g=>g.status==='needs-detail'):null};
});}
function count(b){return b.detailGames===null?(b.scenario?.games??((b.completed||0)+(b.failed||0)+(b.truncated||0))):b.detailGames.length;}
function plan(root,items,{currentRevision,policyIds,threshold=100,now=new Date().toISOString()}){
 const all=candidates(root,items),total=all.reduce((n,b)=>n+count(b),0),current=policyIds[currentRevision];
 if(!current)throw Error('Missing current strategy identity');
 return {version:2,at:now,threshold,totalBefore:total,currentRevision,currentPolicy:current,applicableRevisions:Object.keys(policyIds).filter(r=>policyIds[r]===current),deferred:[],representatives:[],note:"Immediate per-game diagnosis supersedes legacy duplicate deferral. Open strategy issues remain separate; no evidence or conclusions deleted."};
}
function queue(root,items,currentRevision){
 const all=candidates(root,items),p=read(path.join(root,'review-priority.json'),{}),allowed=p.applicableRevisions?.includes(currentRevision),deferred=[],analyzed=[];
 const byKey=new Map((allowed?p.deferred||[]:[]).map(g=>[g.batch+'|'+g.game,g]));
 const active=all.map(b=>{if(b.detailGames===null)return b;const keep=b.detailGames.filter(g=>{
  const diagnosis=require('./case-review.cjs').matching(root,b.id,g);if(diagnosis){analyzed.push({batch:b.id,game:g.id,issues:diagnosis.issues});return false;}
  const old=byKey.get(b.id+'|'+g.id);if(old&&old.signature===signature(g)){deferred.push(old);return false;}return true;
 });return {...b,detailGames:keep};}).filter(b=>b.detailGames===null||b.detailGames.length);
 // New strategy samples first; newest records first within the same priority.
 active.sort((a,b)=>Number(p.applicableRevisions?.includes(b.revision)||b.revision===currentRevision)-Number(p.applicableRevisions?.includes(a.revision)||a.revision===currentRevision)||String(b.endedAt).localeCompare(String(a.endedAt)));
 const detailedGames=active.reduce((n,b)=>n+(b.detailGames?.length||0),0),untriagedGames=active.filter(b=>b.detailGames===null).reduce((n,b)=>n+count(b),0);
 const issues=read(path.join(root,'review-issues.json'),{}),isOpen=id=>issues[id]?.status!=='fixed',openIssueGames=analyzed.filter(g=>g.issues.some(isOpen)).length;
 return {active,deferred,analyzed,summary:{detailedGames,untriagedGames,activeGames:detailedGames+untriagedGames,deferredGames:deferred.length,totalGames:detailedGames+untriagedGames+deferred.length,analyzedGames:analyzed.length,openIssueGames,openIssues:[...new Set(analyzed.flatMap(g=>g.issues).filter(isOpen))]}};
}
function apply(root=DEFAULT_ROOT,repo=path.resolve(__dirname,'..')){
 const items=loadIndex(root),currentRevision=cp.execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),policyIds={};
 for(const revision of new Set([...items.map(b=>b.revision),currentRevision]))if(revision)policyIds[revision]=policyId(repo,revision);
 const next=plan(root,items,{currentRevision,policyIds}),file=path.join(root,'review-priority.json'),old=read(file,null);
 if(old){const dir=path.join(root,'review-priority-history');fs.mkdirSync(dir,{recursive:true});const target=path.join(dir,digest(old)+'.json');if(!fs.existsSync(target))save(target,old);}
 save(file,next);return {plan:next,queue:queue(root,items,currentRevision).summary};
}
module.exports={signature,policyEntries,policyId,plan,queue,apply};
if(require.main===module){const result=apply(process.argv[2]||DEFAULT_ROOT);console.log(JSON.stringify({at:result.plan.at,queue:result.queue,representatives:result.plan.representatives.length}));}
