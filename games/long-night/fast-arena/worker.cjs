'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {play}=require('./game.cjs'),{Engine}=require('./engine.cjs');
let engine=new Engine();
process.on('message',async job=>{
 const started=Date.now();try{
  const result=await play({...job,engine,seats:Array.from({length:job.scenario.players},()=>({id:'current',params:{}})),onStep:(a,evidence)=>{
   fs.appendFileSync(path.join(job.out,'games',job.id+'.actions.jsonl'),JSON.stringify({actor:a.actor,round:a.round,step:a.step,action:a.action,fallback:a.fallback,elapsedMs:a.elapsedMs,timings:a.timings})+'\n');
   if(evidence.actions.length===1||evidence.actions.length%10===0){
    const checkpoint=path.join(job.out,'games',job.id+'.checkpoint.json.gz');
    fs.writeFileSync(checkpoint+'.tmp',zlib.gzipSync(JSON.stringify({scenario:job.scenario,seed:job.seed,complete:false,...evidence}),{level:1}));
    fs.renameSync(checkpoint+'.tmp',checkpoint);
   }
   if(a.step%10===0)process.send({type:'progress',id:job.id,round:a.round,step:a.step});}});
  const elapsedMs=Date.now()-started,steps=result.actions.length;
  const summary={id:job.id,seed:job.seed,complete:result.complete,truncated:result.truncated,scores:result.scores,rounds:result.rounds,steps,elapsedMs,decisionMs:result.actions.reduce((n,a)=>n+(a.elapsedMs||0),0),reason:result.terminationReason||null};
  summary.timeouts=result.actions.filter(a=>a.fallback==='policy-timeout').length;summary.retries=result.actions.filter(a=>a.retried).length;
  result.actions=result.actions.map(a=>({...a,decision:a.decision?{direction:a.decision.primary?.direction,score:a.decision.primary?.score,tactic:a.decision.tactic,reasons:a.decision.primary?.reasons,warnings:a.decision.warnings,...(a.fallback?{moves:a.decision.moves}: {})}:undefined}));
  fs.writeFileSync(path.join(job.out,'games',job.id+'.json.gz'),zlib.gzipSync(JSON.stringify({...result,summary}),{level:1}));
  process.send({type:'done',summary});
 }catch(e){engine.close();engine=new Engine();process.send({type:'done',summary:{id:job.id,seed:job.seed,complete:false,failed:true,error:e.message,elapsedMs:Date.now()-started}});}
});
process.on('disconnect',()=>{engine.close();process.exit(0);});
