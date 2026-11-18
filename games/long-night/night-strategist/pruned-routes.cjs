'use strict';
const {E}=require('./kernel.cjs');
const {edgeState}=require('./movement.cjs');
const {localOutcomes,pattern,wallLabel,collides}=require('./local-outcomes.cjs');
const {VALUES,goalProgress,wallValue}=require('./decision-value.cjs');
const {fraction,add,multiply,divide}=require('./exact-birth.cjs');
const {openingPosterior}=require('./opening-posterior.cjs');
const {trapState,trapArrival}=require('./trap-state.cjs');

function address(phase,n,r,c){
 const row=E.mod(r-phase.pr,n),col=E.mod(c-phase.pc,n);
 return E.phaseAt(phase,n,r,c);
}
function plainPrefix(ctx,to){
 if(!ctx.solution?.phases?.length||ctx.solution.irregular||ctx.batchUnsafe)return false;
 return ctx.solution.phases.every(p=>{
  const a=address(p,ctx.n,to.r,to.c);
  return p.domains[a.slot].length&&p.domains[a.slot].every(m=>{
   const c=m.block.cells[a.i];return c.type==='EMPTY'&&c.attach==='EMPTY';
  });
 });
}
function routes(ctx,from,moves,padding){
 const out=new Map();
 function addRoute(dirs){const key=dirs.map(d=>'上下左右'[d]).join('');out.set(key,dirs);}
 for(const m of moves)if(!m.blocked&&!ctx.turnEdges.has(E.key(from.r,from.c)+':'+m.dirIndex))addRoute([m.dirIndex]);
 for(const p of padding)if(!ctx.batchUnsafe&&out.has('上下左右'[p.directions[0]]))addRoute(p.directions);
 function visit(p,path,seen){
  for(let d=0;d<4;d++){
   if(!path.length&&!out.has('上下左右'[d]))continue;
   const e=edgeState(p,d,ctx,path.at(-1)??ctx.lastDirection);
   if(e.blocked||e.wall!=='空'||e.kinds.length!==1||e.kinds[0]!==0||ctx.turnEdges.has(E.key(p.r,p.c)+':'+d))continue;
   const to={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)},key=E.key(to.r,to.c);
   if(seen.has(key))continue;
   const dirs=[...path,d];
   if(path.length&&!ctx.visited.has(key))addRoute(dirs);
   if(dirs.length<3&&ctx.visited.has(key)&&plainPrefix(ctx,to))visit(to,dirs,new Set([...seen,key]));
  }
 }
 if(!ctx.batchUnsafe)visit(from,[],new Set([E.key(from.r,from.c)]));
 return [...out];
}
function outcome(cell,{silent,event,mask,hasSound,fresh,exit,brawl,discount=0}){
 const gain=fresh?5-discount:-2;
 if(['BOX','JAMMERBOX','HEATBOX','BOMB'].includes(cell.attach))return ['箱子或炸弹风险',-16];
 if(cell.type==='EXIT')return brawl?['舱位可能传送',-4]:exit?['可用逃生舱',VALUES.win]:['逃生舱状态待确认',gain];
 if(cell.type==='TRAP'&&cell.activeTrap)return [cell.uncertainTrap?'陷阱状态未确定（保守按强停计分）':'陷阱 · 再次进入，无声强停',-10];
 if(cell.type==='HEAT'||cell.type==='HEART')return ['特殊地形风险',-9];
 const sound=cell.type==='TRAP'?(event==='RAINSTORY'?'PAPA':'SHASHA'):E.soundTypes(cell.type,event)[0],portal=['PORTAL','ONEWAYPORTAL'].includes(cell.type);
 if(!silent&&sound!=='NONE')return [(sound==='PAPA'?'啪嗒':'沙沙')+(mask?' · 心跳掩盖':hasSound?' · 对外发声':' · 首次保护'),gain-(mask?0:hasSound?12:3)-(portal?10:0)];
 return [cell.type==='EMPTY'?'进入空地':'安静移动',gain-(portal?10:0)];
}
function rank(args){
 const {ctx,node,from,moves,steps,padding,hasSound,config}=args;
 if(!ctx.solution?.phases?.length||ctx.solution.irregular)return null;
 const started=Date.now(),budget={deadline:started+900};
 const posterior=openingPosterior(args,{ms:100,maxLayouts:128,maxNodes:4000}),models=new Map(),options=[];
 const traps=ctx.trapState||trapState({node,config,round:args.round,steps});
 for(const [command,dirs] of routes(ctx,from,moves,padding)){
  let p={...from},prefixButtons=0;for(const d of dirs.slice(0,-1)){p={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)};prefixButtons+=require('./exploration-value.cjs').buttonCost(ctx,p);}
  const d=dirs.at(-1),to={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)},key=E.key(to.r,to.c);
  const last=dirs.at(-2)??ctx.lastDirection,step=steps+dirs.length;
  const modelKey=E.key(p.r,p.c);if(!posterior.worlds&&!models.has(modelKey))models.set(modelKey,localOutcomes({...args,from:p},budget));
  const model=posterior.worlds?posterior:models.get(modelKey),worlds=model.worlds;
  const region=require('./exploration-value.cjs').regionValue(ctx,to);
  const costs=dirs.length*(1+Math.min(4,steps/4))+prefixButtons,results=new Map();
  function record(label,value,mass,meta={}){
   const row=results.get(label)||{label,...meta,low:Infinity,high:-Infinity,mass:[0n,1n],total:[0n,1n]};
   value-=costs;row.low=Math.min(row.low,value);row.high=Math.max(row.high,value);
   if(mass){row.mass=add(row.mass,mass);row.total=add(row.total,multiply(mass,fraction(BigInt(Math.round(4*value)),4n)));}
   results.set(label,row);
  }
  function pass(cell,heart,mass){
   if(!worlds&&config.roomRules?.教程!=='开启'&&cell.type==='EXIT'&&args.round===1&&steps===0&&node?.birth?.r===from.r&&node?.birth?.c===from.c&&dirs.length===1)return;
   if(cell.type==='TRAP'){const t=trapArrival(traps,to);cell={...cell,activeTrap:t.active,uncertainTrap:t.uncertain};}
   const [label,value]=outcome(cell,{silent:ctx.silent,event:config.event,mask:heart&&step<=19&&step%3===1,hasSound,fresh:!ctx.visited.has(key),exit:ctx.probeBayesExit&&!ctx.spentPods.has(key),brawl:ctx.brawl,discount:region.discount});
   const button=cell.attach==='BUTTON';
   const terrain={WATER:'水洼',GRASS:'草丛',PORTAL:'传送门',ONEWAYPORTAL:'传送门出口',BERRY:'浆果丛',TRAP:cell.activeTrap?'':'陷阱本次仅发声，不强停'}[cell.type];
   record(label+(terrain?' · '+terrain:'')+(button?' · 按钮回合末泄露（−14）':'')+(region.birth?' · 出生区低探索收益':region.noExit?' · 非逃生区低探索收益':''),value-(button?VALUES.button:0)+goalProgress(ctx,p,to),mass);
  }
  if(worlds){
   for(const {w,mass} of worlds){
    const i=p.r*ctx.n+p.c,k=w.walls[i][d];
    if(collides(k,d,last)){const shape=pattern(w.walls[i]),value=wallValue(ctx,p,shape);record(wallLabel(shape),value.utility,mass,{wallPattern:shape,reasons:value.reasons});}
    else pass(w.cells[w.next(i,d)],w.heart,mass);
   }
  }else{
   const edge=edgeState(p,d,ctx,last);
   const kinds=[0,1,2,3].map(k=>ctx.wallKinds?.get(modelKey+':'+k)||[0,1,2,3,4]);
   const shapes=new Set();for(const a of kinds[0])for(const b of kinds[1])for(const c of kinds[2])for(const e of kinds[3]){
    const walls=[a,b,c,e];if(collides(walls[d],d,last))shapes.add(pattern(walls));
   }
   for(const shape of shapes){const value=wallValue(ctx,p,shape);record(wallLabel(shape),value.utility,null,{wallPattern:shape,reasons:value.reasons});}
   for(const phase of ctx.solution.phases){
    const a=address(phase,ctx.n,to.r,to.c);
    for(const m of phase.domains[a.slot]){
     for(const types of E.variants(m.block,config.event)){
      const cell={...m.block.cells[a.i],type:types[a.i]};
      pass(cell,config.heartPresence===true);
      if(config.heartPresence==null)pass(cell,true);
     }
    }
   }
  }
  if(!results.size)continue;
  const rows=[...results.values()],total=rows.reduce((v,r)=>add(v,r.mass),[0n,1n]);
  const num=([a,b])=>Number(a)/Number(b);
  const expected=worlds?divide(rows.reduce((v,r)=>add(v,r.total),[0n,1n]),total):null;
  const low=Math.min(...rows.map(r=>r.low)),high=Math.max(...rows.map(r=>r.high));
  const collisionMass=rows.filter(r=>r.wallPattern).reduce((v,r)=>add(v,r.mass),[0n,1n]);
  const outcomes=rows.map(r=>({label:r.label,low:r.low,high:r.high,utility:r.low,wallPattern:r.wallPattern,reasons:r.reasons,scoreBasis:worlds?'conditional-expectation':'worst-case',...(worlds?{
   fraction:divide(r.mass,total).join('/'),probability:num(divide(r.mass,total)),
   ...(r.wallPattern&&collisionMass[0]?{collisionConditionalFraction:divide(r.mass,collisionMass).join('/'),collisionConditionalProbability:num(divide(r.mass,collisionMass))}:{}),
   utilityFraction:divide(r.total,r.mass).join('/'),utility:num(divide(r.total,r.mass)),
   contributionFraction:divide(r.total,total).join('/'),contribution:num(divide(r.total,total))
  }:{})}));
  options.push({command,directions:dirs,outcomes,low,high,score:expected?num(expected):low,expected:expected?.join('/'),model:model.audit,scoreBasis:worlds?'expected-utility':'worst-case',costs:{travel:costs-prefixButtons,buttonPrefix:prefixButtons,regionDiscount:region.discount}});
 }
 options.sort((a,b)=>{
  if(a.expected&&b.expected){
   const [an,ad]=a.expected.split('/').map(BigInt),[bn,bd]=b.expected.split('/').map(BigInt);
   const diff=bn*ad-an*bd;if(diff)return diff>0n?1:-1;
  }
  return b.score-a.score||a.command.length-b.command.length;
 });
 const mode=posterior.worlds?'opening-model':options.every(o=>o.expected)?'local-model':'conservative';
 const originModel=posterior.worlds?posterior:models.get(E.key(from.r,from.c));
 return options.length?{options,mode,positionCandidates:originModel?.positionCandidates,audit:{...(originModel?.audit),elapsedMs:Date.now()-started,globalExact:!!posterior.worlds},valueModel:VALUES}:null;
}
module.exports={rank,plainPrefix};
