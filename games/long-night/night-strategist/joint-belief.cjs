'use strict';
// A posterior over BOTH players' maps. Never use retained layout frequency,
// a pair solver's timeout prefix, or a hidden referee map as a prior.
const {E,T}=require('./kernel.cjs');
const {buildWorld}=require('./bayes-worlds.cjs');
const {birthMass}=require('./particle-birth.cjs');
const {stream}=require('./particle-worker.cjs');
const Timeline=require('../vendor/long-night/timeline.js');
const crypto=require('node:crypto');
const cache=new Map();
function casesFor(input){
 const {built,team}=input,config=built.views[built.self].model.config;
 if(config.size!==9||config.playerCount!==2||team.conflict||built.views.some(v=>v.ambiguities.length||v.model.active!==0||v.localExit))return null;
 const rules=config.roomRules||{};
 if(config.event!=='NONE'||rules.谋定后动==='开启'||rules.隐匿==='开启'||rules.大乱斗==='开启'||Number(rules.炸弹)||rules.BOSS)return null;
 const a=team.nodes.find(n=>n.player===built.self),b=team.nodes.find(n=>n.player!==built.self);
 if(!a?.birth||!b?.birth||[a,b].some(n=>n.routePending||n.solution?.phases?.length!==1))return null;
 const pool=E.pool(config);
 if(pool.some(b=>b.cells.some(c=>['HEAT','HEART'].includes(c.type)||['BOX','HEATBOX','JAMMERBOX','BOMB'].includes(c.attach))))return null;
 const p=a.solution.phases[0],q=b.solution.phases[0],cases=[];
 for(let dr=0;dr<9;dr++)for(let dc=0;dc<9;dc++){
  const indices=p.slots.map(s=>q.slots.findIndex(t=>E.mod(t.r+dr,9)===s.r&&E.mod(t.c+dc,9)===s.c));
  if(indices.includes(-1))continue;
  const domains=p.domains.map((d,i)=>d.filter(m=>q.domains[indices[i]].some(t=>t.id===m.id)));
  if(domains.some(d=>!d.length))continue;
  cases.push({phase:{...p,domains},offset:{dr,dc},observations:a.observations.concat(b.observations.map(o=>T.shift(o,dr,dc,9))),
   births:[{...a.birth,player:a.player},{...T.shift(b.birth,dr,dc,9),player:b.player}],target:T.shift(b.focus,dr,dc,9)});
 }
 return {config,a,b,cases};
}
function currentWorld(c,selected,config){
 const world=buildWorld(c.phase,selected,9);
 const result=Timeline.check(config,selected,c.observations,true);
 if(!result.valid)return null;
 // Replay all known button arrivals chronologically, keeping shared-door
 // correlations. Both complete public routes are present in this model.
 const actions=new Map();
 for(const o of c.observations)if(o.kind==='action'&&o.arrival&&o.clock)actions.set([o.clock.round,o.clock.player,o.clock.step].join(':'),o);
 for(const o of [...actions.values()].sort((a,b)=>a.clock.round-b.clock.round||a.clock.player-b.clock.player||a.clock.step-b.clock.step)){
  const cell=world.cells[o.r*9+o.c];
  if(cell.attach!=='BUTTON')continue;
  for(const [dr,dc,name] of cell.buttons||[]){const d={UP:0,DOWN:1,LEFT:2,RIGHT:3}[name],i=E.mod(o.r+dr,9)*9+E.mod(o.c+dc,9),j=world.next(i,d),v=world.walls[i][d];if(v===3||v===4)world.walls[i][d]=world.walls[j][E.OPP[d]]=7-v;}
 }
 return world;
}
function infer(input,{budgetMs=350,maxTrials=4000,seed='joint-v1',minEss=48}={}){
 const model=casesFor(input);if(!model?.cases.length)return {status:'unavailable',reason:'requires two unambiguous initial frames and supported rules'};
 const {config,cases}=model;
 const key=crypto.createHash('sha256').update(JSON.stringify([seed,config,cases.map(c=>[c.offset,c.phase.domains.map(d=>d.map(m=>m.id)),c.observations,c.births])])).digest('hex');
 if(cache.has(key))return cache.get(key);
 const rng=stream(key),deadline=Date.now()+budgetMs,rows=[];let cycles=0,attempts=0;
 // Complete balanced cycles only: a partially sampled alignment must not
 // acquire a smaller prior because the wall clock expired before its turn.
 while(cycles<maxTrials&&Date.now()<deadline){const batch=[];let interrupted=false;
  for(const c of cases){if(Date.now()>=deadline){interrupted=true;break;}attempts++;
   const used=new Set(),selected=[],order=c.phase.domains.map((_,i)=>i).sort((i,j)=>c.phase.domains[i].length-c.phase.domains[j].length);let weight=1,exits=0;
   for(const i of order){const left=9-used.size,need=config.exitCount-exits,options=c.phase.domains[i].filter(m=>!used.has(m.id)&&(m.id.startsWith('E')?need>0:need<left));if(!options.length)break;const m=options[Math.floor(rng()*options.length)];weight*=options.length;selected[i]=m;used.add(m.id);exits+=Number(m.id.startsWith('E'));}
   if(used.size!==9)continue;
   if(E.verifyCompleteLayout({...config,births:[]},{phases:[{...c.phase,domains:selected.map(m=>[m])}]},c.observations,64).status!=='verified')continue;
   let birth;try{birth=birthMass(buildWorld(c.phase,selected,9),c.births,2,rng,()=>{if(Date.now()>=deadline)throw Error('budget');});}catch(e){if(e.message!=='budget')throw e;interrupted=true;break;}
   if(!birth)continue;
   const world=currentWorld(c,selected,config);if(world)batch.push({world,target:c.target,birth:c.births.find(b=>b.player!==model.a.player),weight:weight*birth});
  }
  if(interrupted)break;cycles++;rows.push(...batch);
 }
 const sum=rows.reduce((s,r)=>s+r.weight,0),sq=rows.reduce((s,r)=>s+r.weight*r.weight,0),ess=sq?sum*sum/sq:0,positions=new Map();
 for(const row of rows){const k=E.key(row.target.r,row.target.c),p=positions.get(k)||{r:row.target.r,c:row.target.c,mass:0};p.mass+=row.weight;positions.set(k,p);}
 const out={status:ess>=minEss?'estimated':'insufficient',rows,positions:[...positions.values()].map(p=>({r:p.r,c:p.c,probability:p.mass/sum})).sort((a,b)=>b.probability-a.probability),audit:{seed,attempts,cycles,samples:rows.length,ess,alignments:cases.length,scope:'joint map and birth prior; opponent action choice unmodelled',unseenMassNotProvenZero:true}};
 if(out.status==='estimated'){cache.set(key,out);if(cache.size>8)cache.delete(cache.keys().next().value);}
 return out;
}
module.exports={casesFor,currentWorld,infer};
