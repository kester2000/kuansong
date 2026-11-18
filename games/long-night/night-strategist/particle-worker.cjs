'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {E}=require('./kernel.cjs'),{buildWorld}=require('./bayes-worlds.cjs'),{birthMass}=require('./particle-birth.cjs');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function stream(seed){let s=parseInt(hash(seed).slice(0,8),16);return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
function run(q){
 const start=Date.now(),deadline=start+q.budgetMs,rng=stream(q.seed),check=()=>{if(Date.now()>=deadline)throw Error('budget');};
 const config={...q.config,births:[]},phases=q.phases.map(p=>({...p,domains:p.domains.map((ids,i)=>ids.map(id=>({id,block:E.byId.get(id),origin:p.slots[i]})))}));
 const identity=hash([q.config.pool,q.config.mode,q.config.playerCount,q.config.exitCount,q.births,q.session,q.config.heartPresence]);
 const evidence=hash([q.observations,q.config]);let previous=null;
 try{previous=JSON.parse(fs.readFileSync(q.cache,'utf8'));if(previous.identity!==identity)previous=null;}catch{}
 const audit={method:'conditional-importance',attempts:0,retained:0,replenished:false,limited:false,scope:'本人及已对齐轨迹的地图约束；未对齐玩家策略未建模'};
 const validate=(row)=>{
  check();const phase=phases.find(p=>p.pr===row.pr&&p.pc===row.pc);if(!phase)return null;
  const selected=row.ids.map((id,i)=>phase.domains[i].find(m=>m.id===id));if(selected.some(m=>!m))return null;
  if(E.verifyCompleteLayout(config,{phases:[{...phase,domains:selected.map(m=>[m])}]},q.observations,64).status!=='verified')return null;
  return {phase,selected};
 };
 let rows=[];
 E.setDeadline(deadline);
 try{
  // Reuse only a genuine extension of the same evidence, never an edited or
  // shorter history. Old importance weights retain their proposal measure.
  if(previous&&previous.observations.length<=q.observations.length&&previous.observations.every((o,i)=>JSON.stringify(o)===JSON.stringify(q.observations[i]))){
   if(previous.evidence===evidence){rows=previous.rows;audit.cached=true;}
   else for(const row of previous.rows)if(validate(row))rows.push(row);
   audit.retained=rows.length;
  }
  const stats=rs=>{const z=rs.reduce((s,r)=>s+r.weight,0),sq=rs.reduce((s,r)=>s+r.weight*r.weight,0);return {ess:sq?z*z/sq:0,total:z};};
  if(stats(rows).ess<q.minEss&&!audit.cached){
   // A fresh conditional proposal REPLACES the old bank. Mixing samples from
   // two different proposals without multiple-importance weights is biased.
   rows=[];audit.replenished=true;
   const order=phases.map(p=>p.domains.map((_,i)=>i).sort((a,b)=>p.domains[a].length-p.domains[b].length));
   for(let trial=0;trial<q.maxTrials;trial++){
    check();audit.attempts++;
    const pi=Math.floor(rng()*phases.length),phase=phases[pi],used=new Set(),selected=Array(9);let weight=phases.length,exits=0;
    for(const slot of order[pi]){
     const left=9-used.size,need=config.exitCount-exits;
     const choices=phase.domains[slot].filter(m=>!used.has(m.id)&&(m.id.startsWith('E')?need>0:need<left));
     if(!choices.length)break;
     const m=choices[Math.floor(rng()*choices.length)];weight*=choices.length;selected[slot]=m;used.add(m.id);exits+=Number(m.id.startsWith('E'));
    }
    if(used.size!==9)continue;
    const row={pr:phase.pr,pc:phase.pc,ids:selected.map(m=>m.id),weight};
    if(!validate(row))continue;
    const world=buildWorld(phase,selected,9),birth=birthMass(world,q.births,config.playerCount,rng,check);
    if(birth>0)rows.push({...row,weight:weight*birth});
    if(rows.length>=q.target)break;
   }
  }
 }catch(e){if(e.message==='budget'||e.code==='INFERENCE_TIMEOUT')audit.limited=true;else throw e;}finally{E.setDeadline();}
 // If validation was interrupted, discard the partial reuse bank rather than
 // silently using an evidence-dependent prefix of the previous samples.
 if(audit.limited&&!audit.replenished&&!audit.cached)rows=[];
 const total=rows.reduce((s,r)=>s+r.weight,0),sq=rows.reduce((s,r)=>s+r.weight*r.weight,0);
 Object.assign(audit,{samples:rows.length,ess:sq?total*total/sq:0,distinct:new Set(rows.map(r=>[r.pr,r.pc,...r.ids].join('/'))).size,elapsedMs:Date.now()-start,maxWeight:total?Math.max(...rows.map(r=>r.weight))/total:1});
 const out={identity,evidence,observations:q.observations,rows,audit};
 if(rows.length){const tmp=q.cache+'.'+process.pid+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(out));fs.renameSync(tmp,q.cache);}catch(e){audit.cacheError=e.code;try{fs.unlinkSync(tmp);}catch{}}}
 return out;
}
if(require.main===module){try{const q=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(run(q)));}catch(e){process.stdout.write(JSON.stringify({error:e.message}));}}
module.exports={run,stream};
