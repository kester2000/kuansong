'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const dir=process.argv[2],report=JSON.parse(fs.readFileSync(path.join(dir,'report.json')));
console.log(JSON.stringify({finished:report.finished,completed:report.completed,timeouts:report.timeouts,truncated:report.truncated,failed:report.failed}));
for(const r of report.results.filter(r=>r.timeouts||!r.complete)){
 const file=path.join(dir,'games',r.id+'.json.gz');
 if(!fs.existsSync(file)){console.log(JSON.stringify(r));continue;}
 const game=JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
 const a=game.actions.find(a=>a.fallback==='policy-timeout')||game.actions.at(-2);
 console.log(JSON.stringify({id:r.id,seed:r.seed,timeouts:r.timeouts,reason:r.reason,actor:a.actor,round:a.round,step:a.step,messageCount:a.messageCount,
  tactic:a.decision?.tactic,warnings:a.decision?.warnings,moves:a.decision?.moves?.map(m=>({d:m.direction,b:m.blocked,l:m.loopBlocked,f:m.explorationForbidden,br:m.branchRisk,types:m.terrain})),tail:game.actions.slice(-8).map(a=>a.action)}));
}
