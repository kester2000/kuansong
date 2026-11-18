'use strict';
const {E}=require('./kernel.cjs');
const {blockAssignmentPrior}=require('./block-prior.cjs');
const {add,multiply,divide,fraction}=require('./exact-birth.cjs');
const {completionCounter}=require('./block-marginal.cjs');
const {normalSpawnFits}=require('./spawn-constraints.cjs');
const ZERO=[0n,1n],ONE=[1n,1n];
const address=(p,n,r,c)=>{const {slot,i}=E.phaseAt(p,n,r,c);return {slot,cell:i};};
const pattern=walls=>walls.map(E.wallFeedback).join('');
const wallLabel=p=>'撞墙 · '+[...p].map((v,d)=>'上下左右'[d]+v).join(' ');
const collides=(wall,d,last)=>wall===1||wall===3||wall===2&&last!==d;

// A bounded, explicit local model. Unqueried slots are marginalized through
// the draw prior, rather than enumerated as full maps. Birth/connectivity and
// distant uncertain evidence are NOT silently advertised as fully integrated.
function enumerateLocal({ctx,node,config,from,round=1,steps=0},budget,marginalize){
 const started=Date.now(),fail=reason=>({worlds:null,audit:{status:'local-unavailable',complete:false,reason,elapsedMs:Date.now()-started}});
 if(Date.now()>=budget.deadline)return fail('局部枚举总预算已用尽');
 if((ctx.n%3&&![10,11].includes(ctx.n))||ctx.solution?.irregular||!ctx.solution?.phases?.length||config.event!=='NONE'||Number(config.roomRules?.炸弹))return fail('当前特殊规则不在局部概率模型内');
 const pool=E.pool({...config,heartPresence:null,preferATM:false}),hearts=pool.filter(b=>b.cells.some(c=>c.type==='HEART'));
 if(hearts.length>1||pool.some(b=>b.cells.some(c=>['BOX','HEATBOX','JAMMERBOX','BOMB'].includes(c.attach))))return fail('推箱、爆炸或多个心脏需要额外状态，未编造概率');
 const model={pool,slots:[10,11].includes(ctx.n)?9:(ctx.n/3)**2,exitCount:config.exitCount,custom:config.mode==='CUSTOM'};
 if(!Number.isInteger(model.exitCount))return fail('逃生舱数量未确认');
 const at=from.r*ctx.n+from.c,next=(i,d)=>E.mod(Math.floor(i/ctx.n)+E.V[d][0],ctx.n)*ctx.n+E.mod(i%ctx.n+E.V[d][1],ctx.n);
 const queries=[at,...[0,1,2,3].map(d=>next(at,d))],groups=new Map(),priors=new Map(),existence=new Map(),candidates=new Map();
 const observations=node?.mergedObservations||node?.observations||[],counterStats=[];
 let nodes=0,leaves=0,localSlots=0,doorAssumption=false;
 const prior=chosen=>{
  const key=[...chosen.values()].map(m=>m.id).sort().join('/');
  if(!priors.has(key))priors.set(key,blockAssignmentPrior({...model,assignments:[...chosen].map(([slot,m])=>({slot,id:m.id}))}));
  return priors.get(key);
 };
 try{
  for(const [pi,phase] of ctx.solution.phases.entries()){
   const locs=queries.map(i=>address(phase,ctx.n,Math.floor(i/ctx.n),i%ctx.n)),slots=[...new Set(locs.map(l=>l.slot).filter(s=>s>=0))];localSlots=Math.max(localSlots,slots.length);
   const chosen=new Map(),used=new Set();
   const owner=s=>s<0?phase.domains[-1][0]:chosen.get(s);
   // Certain remote blocks consume their IDs and exit quota as well.
   for(const [slot,ds] of phase.domains.entries())if(ds.length===1){const m=ds[0];if(used.has(m.id))return fail('固定区块冲突');chosen.set(slot,m);used.add(m.id);}
   const order=slots.filter(s=>!chosen.has(s)).sort((a,b)=>phase.domains[a].length-phase.domains[b].length);
   const counter=marginalize?completionCounter({phase,slots:[...new Set([...slots,...chosen.keys()])],pool,exitCount:model.exitCount,custom:model.custom,deadline:budget.deadline}):null;
   // Domains alone do not preserve correlations at a seam. Check every
   // observed seam whose owners are included in this local assignment.
   const evidence=observations.flatMap(o=>{
    const ds=o.kind==='walls'?[0,1,2,3].filter(d=>o.value[d]!=='?'):['hit','pass'].includes(o.kind)?[o.dir]:[];
    return ds.map(d=>({o,d,a:address(phase,ctx.n,o.r,o.c),b:address(phase,ctx.n,o.r+E.V[d][0],o.c+E.V[d][1])}));
   });
   function visit(depth){
    if(++nodes%32===0&&Date.now()>=budget.deadline)throw Error('局部枚举达到总预算；不归一化未完成的结果');
    if(depth<order.length){const slot=order[depth];for(const m of phase.domains[slot]){if(used.has(m.id))continue;chosen.set(slot,m);used.add(m.id);visit(depth+1);used.delete(m.id);chosen.delete(slot);}return;}
    leaves++;
    if(!normalSpawnFits({phase,chosen,n:ctx.n,birth:node?.birth,config}))return;
    for(const {o,d,a,b} of evidence)if(owner(a.slot)&&owner(b.slot)){
     const raw=Math.max(owner(a.slot).block.cells[a.cell].walls[d],owner(b.slot).block.cells[b.cell].walls[E.OPP[d]]);
     const kinds=config.dynamicDoors&&[3,4].includes(raw)?[3,4]:[raw];
     if(!kinds.some(k=>E.edgeFits(k,o,d,false)))return;
    }
    let mass,heartMass=ZERO;
    if(counter){
     const [count,heart]=counter.count(chosen);if(!count)return;
     mass=multiply(counter.unit,[count,1n]);heartMass=fraction(heart,count);
    }else{
    const usedKey=pi+':'+[...used].sort().join('/');
    if(!existence.has(usedKey)){
     const rest=phase.domains.filter((_,slot)=>!chosen.has(slot)).map(ds=>ds.filter(m=>!used.has(m.id)));
     const exits=[...chosen.values()].filter(m=>m.id.startsWith('E')).length;
     existence.set(usedKey,exits<=model.exitCount&&E.hasDistinctAssignment(rest,model.exitCount-exits));
    }
    if(!existence.get(usedKey))return;
    mass=prior(chosen);if(!mass[0])return;
    if(hearts.length){
     if(used.has(hearts[0].id))heartMass=ONE;
     else if(chosen.size<model.slots){const slot=phase.domains.findIndex((_,i)=>!chosen.has(i));const extra=new Map(chosen);extra.set(slot,{id:hearts[0].id});heartMass=multiply(divide(prior(extra),mass),[BigInt(model.slots-chosen.size),1n]);}
    }
    }
    const cells=locs.map(l=>owner(l.slot).block.cells[l.cell]);
    if(heartMass[0]>heartMass[1])throw Error('心脏先验不一致');
    const heartBranches=config.heartPresence===true?[[true,heartMass]]:config.heartPresence===false?[[false,fraction(heartMass[1]-heartMass[0],heartMass[1])]]:[[false,fraction(heartMass[1]-heartMass[0],heartMass[1])],[true,heartMass]];
    const choices=[0,1,2,3].map(d=>{
     const raw=Math.max(cells[0].walls[d],cells[d+1].walls[E.OPP[d]]),known=ctx.walls?.get(E.key(from.r,from.c)+':'+d);
     let values=config.dynamicDoors&&[3,4].includes(raw)&&!(round===1&&steps===0&&node?.player===0)?[3,4]:[raw];
     if(known==='墙'||known==='空')values=values.filter(w=>E.wallFeedback(w)===known);
     if(values.length>1)doorAssumption=true;
     return values;
    });
    if(choices.some(v=>!v.length))return;
    const variants=choices.reduce((xs,vs)=>xs.flatMap(x=>vs.map(v=>[...x,v])),[[]]);
    for(const walls of variants)for(const [heart,h] of heartBranches){
     if(!h[0])continue;
     const key=JSON.stringify([cells.map(c=>[c.type,c.attach,c.portal]),walls,heart]);
     const weight=divide(multiply(mass,h),[BigInt(variants.length),1n]);
     const origin=owner(locs[0].slot),candidateKey=origin.id+':'+locs[0].cell;
     const candidate=candidates.get(candidateKey)||{block:origin.id,name:origin.block.name||origin.name||'',row:Math.floor(locs[0].cell/3)+1,col:locs[0].cell%3+1,mass:ZERO,next:[0,1,2,3].map(()=>new Map())};
     candidate.mass=add(candidate.mass,weight);
     for(let d=0;d<4;d++){const type=collides(walls[d],d,ctx.lastDirection)?'COLLISION':cells[d+1].type;candidate.next[d].set(type,add(candidate.next[d].get(type)||ZERO,weight));}
     candidates.set(candidateKey,candidate);
     if(groups.has(key)){const g=groups.get(key);g.mass=add(g.mass,weight);continue;}
     const map=[];queries.forEach((q,i)=>map[q]=cells[i]);const ws=[];ws[at]=walls;
     groups.set(key,{mass:weight,w:{n:ctx.n,cells:map,walls:ws,next,heart}});
    }
   }
   visit(0);
   if(counter)counterStats.push(counter.stats());
  }
 }catch(error){return fail(error.message);}
 if(!groups.size)return fail('局部线索没有相容组合');
 const total=[...candidates.values()].reduce((s,c)=>add(s,c.mass),ZERO),num=f=>Number(f[0])/Number(f[1]);
 const positionCandidates=[...candidates.values()].map(c=>({
  block:c.block,name:c.name,row:c.row,col:c.col,weight:c.mass.join('/'),fraction:divide(c.mass,total).join('/'),probability:num(divide(c.mass,total)),
  directions:c.next.map((m,d)=>({direction:'上下左右'[d],outcomes:[...m].map(([type,mass])=>({type,fraction:divide(mass,c.mass).join('/'),probability:num(divide(mass,c.mass))}))}))
 }));
 positionCandidates.sort((a,b)=>b.probability-a.probability||String(a.block).localeCompare(String(b.block))||a.row-b.row||a.col-b.col);
 return {worlds:[...groups.values()],positionCandidates,audit:{status:'local-model',complete:true,scope:'local',globalExact:false,nodes,layouts:leaves,groups:groups.size,localSlots,elapsedMs:Date.now()-started,
  marginalization:marginalize?'domain-count':'draw-prior',counterStats,candidateCount:positionCandidates.length,positionKind:node?.birth?.r===from.r&&node?.birth?.c===from.c?'出生点':'当前位置',birthWeight:'未完成全图出生权重；以下为抽图及局部反馈条件下的概率',
  reason:'枚举当前格及四邻涉及的 '+localSlots+' 个区块，'+(marginalize?'对其余区块的相容域摆法精确计数求和':'按不放回抽取先验加权')+'；全图出生/连通性及远处线索间的关联未完整积分',
  assumptions:[...(node?.birth?['局部模型按常规出生方案：不在逃生舱区块，出生到舱位的初始可通行路径至少 5 格；回退出生方案由完整出生模型处理']:[]),...(doorAssumption?['未知机关门的开/闭状态在本局部模型中等权；这不是已验证的全图门状态后验']:[])],
  formula:marginalize?'局部组合权重 = 每个完整抽图的先验 × 剩余区块相容域摆法数 × 已检查反馈的似然；按候选格子汇总后归一化':'局部组合权重 = 抽图区块先验 × 已知局部线索似然；同一结果权重求和后归一化'}};
}
function localOutcomes(args,budget={deadline:Date.now()+600}){
 const started=Date.now(),remaining=budget.deadline-started;
 if(remaining<=0)return {worlds:null,audit:{status:'local-unavailable',complete:false,reason:'局部枚举总预算已用尽',elapsedMs:0}};
 const counted=enumerateLocal(args,{deadline:started+Math.max(1,Math.min(250,remaining*0.45))},true);
 if(counted.worlds)return counted;
 const fallback=enumerateLocal(args,budget,false);
 fallback.audit.countingFallback=counted.audit.reason;fallback.audit.elapsedMs=Date.now()-started;
 return fallback;
}
function assignmentWeights(config,n){
 const pool=E.pool({...config,heartPresence:null,preferATM:false}),hearts=pool.filter(b=>b.cells.some(c=>c.type==='HEART'));
 if(hearts.length>1)throw Error('多个心脏的局部权重未支持');
 const model={pool,slots:[10,11].includes(n)?9:(n/3)**2,exitCount:config.exitCount,custom:config.mode==='CUSTOM'},cache=new Map();
 const prior=chosen=>{
  const key=[...chosen.values()].map(m=>m.id).sort().join('/');
  if(!cache.has(key))cache.set(key,blockAssignmentPrior({...model,assignments:[...chosen].map(([slot,m])=>({slot,id:m.id}))}));
  return cache.get(key);
 };
 return (chosen,heart)=>{
  const p=prior(chosen);if(!p[0])return p;
  let h=ZERO;
  if(hearts.length){
   if([...chosen.values()].some(m=>m.id===hearts[0].id))h=ONE;
   else if(chosen.size<model.slots){let slot=0;while(chosen.has(slot))slot++;const extra=new Map(chosen);extra.set(slot,{id:hearts[0].id});h=multiply(divide(prior(extra),p),[BigInt(model.slots-chosen.size),1n]);}
  }
  return multiply(p,heart?h:fraction(h[1]-h[0],h[1]));
 };
}
module.exports={localOutcomes,assignmentWeights,pattern,wallLabel,collides,address};
