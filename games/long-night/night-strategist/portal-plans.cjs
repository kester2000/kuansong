'use strict';
const K=require('./kernel.cjs'),{E}=K;
const {turnFacts}=require('./local-exit.cjs');
const {address}=require('./exploration-value.cjs');
const {assignmentWeights,pattern,wallLabel}=require('./local-outcomes.cjs');
const {add,multiply,divide,fraction}=require('./exact-birth.cjs');
const {VALUES,wallValue}=require('./decision-value.cjs');
const {normalSpawnFits}=require('./spawn-constraints.cjs');
const {trapState,trapArrival}=require('./trap-state.cjs');
const chars='上下左右';
const names={WATER:'水洼',PORTAL:'传送门',ONEWAYPORTAL:'单向传送门',EMPTY:'空地',GRASS:'草丛',EXIT:'逃生舱',TRAP:'陷阱'};
function sequences(remaining){
 const plans=[{dirs:[],stop:true}];
 for(let d=0;d<4;d++){
  if(remaining===1)plans.push({dirs:[d],stop:false});
  else {plans.push({dirs:[d],stop:true});for(let e=0;e<4;e++)plans.push({dirs:[d,e],stop:false});}
 }
 return plans;
}
const stopValue=(heart,space)=>({cost:12,maskBenefit:heart&&space===1?14:0});
function origins(solution,n,entry){
 const rows=[];
 for(const phase of solution.phases){
  const a=address(phase,n,entry.r,entry.c);
  for(const m of phase.domains[a.slot]){
   for(const type of m.cellTypes?.[a.i]||[m.block.cells[a.i].type]){
    if(!E.soundTypes(type,'NONE').includes('PAPA'))continue;
    const cell={...m.block.cells[a.i],type};
    rows.push({phase,m,slot:a.slot,i:a.i,cell,id:phase.pr+','+phase.pc+':'+m.id+':'+a.i+':'+type});
   }
  }
 }
 return rows;
}
// Exhaust the local tree, preserving each block choice across both moves.
// Support bounds must never be normalized as though they were world masses.
function evaluatePlan(seed,plan,{n,entry,elapsed,past,config,steps,birth,entryDir=-1,weight=null,budget=null,knownWalls=new Map(),traps=null}){
 const {phase,m,slot,cell}=seed,assignments=new Map([[slot,m]]),labels=new Map();
 for(const [i,ds] of phase.domains.entries())if(ds.length===1)assignments.set(i,ds[0]);
 if(new Set([...assignments.values()].map(m=>m.id)).size!==assignments.size)return [];
 const check=()=>{if(budget&&Date.now()>=budget.deadline)throw Error('LOCAL_PLAN_BUDGET');};
 const initial={...entry,last:past.at(-1)?.dir??entryDir,space:cell.type==='PORTAL'?2-elapsed:0,traps:new Map(),
  wallStates:new Map(),chance:seed.typeWeight||[1n,1n],portal:cell.type==='PORTAL'?cell:null,score:0,feedback:[],reasons:[],seen:new Set([E.key(entry.r,entry.c)]),ended:false};
 if(cell.type!=='PORTAL')for(const t of past){initial.r=E.mod(initial.r+E.V[t.dir][0],n);initial.c=E.mod(initial.c+E.V[t.dir][1],n);initial.seen.add(E.key(initial.r,initial.c));}
 const finish=s=>{
  check();
  if(!normalSpawnFits({phase,chosen:assignments,n,birth,config}))return;
  let score=s.score;const reasons=[...s.reasons],feedback=[...s.feedback];
  if(plan.stop&&!s.ended){const v=stopValue(config.heartPresence===true,s.space);score+=v.maskBenefit-v.cost;
   feedback.push('停止');reasons.push('交出行动权 −'+v.cost+'；无墙壁反馈');
   if(v.maskBenefit)reasons.push('传送分支下回合第1步出门，可被心跳掩声 +'+v.maskBenefit);
  }
  const key=feedback.join(' → ')||'停止',old=labels.get(key);
  if(!old)labels.set(key,{label:key,low:score,high:score,reasons,wallPattern:s.wallPattern,mass:[0n,1n],total:[0n,1n]});else {old.low=Math.min(old.low,score);old.high=Math.max(old.high,score);}
  if(weight){const row=labels.get(key),mass=multiply(weight(assignments,config.heartPresence===true),s.chance);row.mass=add(row.mass,mass);row.total=add(row.total,multiply(mass,fraction(BigInt(Math.round(score*4)),4n)));}
 };
 function selected(at,fn){
  check();
  const loc=address(phase,n,at.r,at.c),old=assignments.get(loc.slot);
  // Looking up a wall must not multiply branches by unrelated terrain
  // alternatives. Use one consistent template state for each selected block.
  const emit=candidate=>{const type=loc.slot===slot&&loc.i===seed.i&&candidate.id===m.id?cell.type:candidate.block.cells[loc.i].type;fn({...candidate.block.cells[loc.i],type},loc);};
  if(old){emit(old);return;}
  for(const candidate of phase.domains[loc.slot]){
   if([...assignments.values()].some(m=>m.id===candidate.id))continue;
   assignments.set(loc.slot,candidate);
   if(E.hasDistinctAssignment(phase.domains.map((d,i)=>assignments.has(i)?[assignments.get(i)]:d),config.exitCount))emit(candidate);
   assignments.delete(loc.slot);
  }
 }
 function arrival(s,to,c,index,teleported=false){
  if(c.type==='TRAP'&&c.activeTrap==null){
   const key=E.key(to.r,to.c),known=s.traps.get(key);
   const t=known==null?trapArrival(traps,to):{active:!known,uncertain:false};
   arrival({...s,traps:new Map([...s.traps,[key,t.active]])},to,{...c,activeTrap:t.active,uncertainTrap:t.uncertain},index,teleported);
   return;
  }
  const beat=steps+index+1,masked=config.heartPresence===true&&beat<=19&&beat%3===1,sound=c.type==='TRAP'?(c.activeTrap?'NONE':'SHASHA'):E.soundTypes(c.type,config.event)[0];
  const loc=address(phase,n,to.r,to.c),sameBirth=birth&&loc.slot===address(phase,n,birth.r,birth.c).slot;
  const owner=assignments.get(loc.slot),noExit=owner&&!owner.block.cells.some(c=>c.type==='EXIT'),fresh=!s.seen.has(E.key(to.r,to.c));
  let value=(fresh?5-(sameBirth?6:noExit?3:0):-2)-1,label=names[c.type]||c.type;
  if(c.type==='TRAP')label+=c.uncertainTrap?'状态未确定（保守按强停计分）':c.activeTrap?' · 再次进入，无声强停':' · 本次仅发声，不强停';
  const reasons=[...s.reasons,'移动 −1',fresh?(sameBirth?'出生区探索 −1':noExit?'非逃生区探索 +2':'新格探索 +5'):'重复格 −2'];
  if(sound!=='NONE'&&!config.silent){value-=masked?0:12;label+=' · '+(masked?'心跳掩声':sound==='PAPA'?'啪嗒对外发声':'沙沙对外发声');reasons.push('声音暴露 −'+(masked?0:12));}
  if(c.attach==='BUTTON'){value-=14;label+=' · 按钮';reasons.push('回合末按钮公告泄露 −14');}
  const danger=['HEAT','HEART'].includes(c.type)||c.type==='TRAP'&&c.activeTrap||['BOMB','BOX','HEATBOX','JAMMERBOX'].includes(c.attach);
  if(danger){value-=20;reasons.push('危险或强停风险 −20');}
  if(c.type==='EXIT'&&!config.brawl){const gain=config.knownAvailableExit?VALUES.win:60;value+=gain;reasons.push(config.knownAvailableExit?'确认可用逃生舱 +'+gain:'舱位可用性待确认 +'+gain);}
  walk({...s,...to,buttonTouched:s.buttonTouched||c.attach==='BUTTON',wallStates:c.attach==='BUTTON'?new Map():s.wallStates,space:c.type==='PORTAL'&&!teleported?2:0,portal:c.type==='PORTAL'?c:null,score:s.score+value,
   feedback:[...s.feedback,label],reasons,seen:new Set([...s.seen,E.key(to.r,to.c)]),ended:danger||c.type==='EXIT'},index+1);
 }
 function wallChoices(s,p,d,raw){
  const q={r:E.mod(p.r+E.V[d][0],n),c:E.mod(p.c+E.V[d][1],n)},key=[p.r*n+p.c,q.r*n+q.c].sort((a,b)=>a-b).join('/');
  if(s.wallStates.has(key))return [{wall:s.wallStates.get(key),state:s}];
  const known=s.buttonTouched?null:knownWalls.get(E.key(p.r,p.c)+':'+d);
  const options=(config.dynamicDoors&&[3,4].includes(raw)?[3,4]:[raw]).filter(w=>!['墙','空'].includes(known)||E.wallFeedback(w)===known);
  return options.map(wall=>({wall,state:{...s,chance:divide(s.chance,[BigInt(options.length),1n]),wallStates:new Map([...s.wallStates,[key,wall]])}}));
 }
 function collision(s,hitDir,hitWall){
  function sides(state,d,walls){
   if(d===4){const shape=pattern(walls),v=wallValue({n,walls:knownWalls},state,shape);
    finish({...state,wallPattern:shape,score:state.score+v.utility-1,feedback:[...state.feedback,wallLabel(shape)],reasons:[...state.reasons,'尝试移动 −1',...v.reasons],ended:true});return;}
   if(d===hitDir){sides(state,d+1,[...walls,hitWall]);return;}
   selected(state,left=>{const to={r:E.mod(state.r+E.V[d][0],n),c:E.mod(state.c+E.V[d][1],n)};
    selected(to,right=>{for(const {wall,state:next} of wallChoices(state,state,d,Math.max(left.walls[d],right.walls[E.OPP[d]])))sides(next,d+1,[...walls,wall]);});});
  }
  sides(s,0,[]);
 }
 function walk(s,index){
  if(index===plan.dirs.length||s.ended){finish(s);return;}
  const d=plan.dirs[index];
  if(s.space){
   if(s.space>1){walk({...s,space:s.space-1,last:d,score:s.score-1,feedback:[...s.feedback,'亚空间无声移动'],reasons:[...s.reasons,'推进传送 −1']},index+1);return;}
   const delta=s.portal?.portal;if(!Array.isArray(delta))return;
   const to={r:E.mod(s.r+delta[0],n),c:E.mod(s.c+delta[1],n)};
   selected(to,c=>arrival({...s,last:d},to,c,index,true));return;
  }
  selected(s,left=>{
   const to={r:E.mod(s.r+E.V[d][0],n),c:E.mod(s.c+E.V[d][1],n)};
   selected(to,right=>{
    const raw=Math.max(left.walls[d],right.walls[E.OPP[d]]);
    for(const {wall,state} of wallChoices(s,s,d,raw)){
     if(wall===1||wall===3||wall===2&&s.last!==d){collision(state,d,wall);continue;}
     arrival({...state,last:d},to,right,index);
    }
   });
  });
 }
 walk(initial,0);return [...labels.values()].map(r=>({...r,utility:r.low}));
}
function portalPlans(input){
 const {built,journal,team}=input,self=built.self,v=built.views[self];
 if(!journal||v.model?.config?.portalChaos||v.localExit||team?.conflict||v.ambiguities.length!==1)return null;
 const a=v.ambiguities[0],facts=turnFacts(journal,self,a.round),elapsed=facts.steps-a.step,latest=v.roundEnds.at(-1),config=v.model.config;
 if(!latest||latest.complete||latest.round!==a.round||elapsed<0||elapsed>1||a.silentUnknown||a.recoveryUnknown||config.silent||config.event!=='NONE'||Number(config.roomRules?.炸弹)||config.brawl)return null;
 if(facts.moves[a.step-1]?.sound!=='PAPA'&&!a.maskedUnknown)return null;
 const past=facts.moves.slice(a.step);if(past.some(t=>t.outcome!=='move'||t.sound||t.terrain))return null;
 const node=team.nodes.find(n=>n.id===self+':'+a.segment);
 if(!node?.solution?.phases?.length||node.solution.irregular)return null;
 let seeds=origins(node.solution,config.size,a.entry);
 // Quiet moves since entry constrain the ground branch, but do not constrain
 // subspace directions. Never force the entire candidate list onto the ground.
 if(elapsed){
  const choices=E.clone(built.resolvedChoices||{});choices[self]={...(choices[self]||{}),[a.key]:{kind:'ground'}};
  const ground=K.build(journal,choices).views[self],at=E.replay(ground.model.segments[a.segment],config.size);
  const solved=E.solveMap(ground.model.config,at.observations,[]);
  seeds=seeds.flatMap(s=>{
   if(s.cell.type==='PORTAL')return [s];
   const phase=solved.phases.find(p=>p.pr===s.phase.pr&&p.pc===s.phase.pc);
   return phase?.domains[s.slot].some(m=>m.id===s.m.id)?[{...s,phase}]:[];
  });
 }
 let options=[];const remaining=2-elapsed,started=Date.now();
 if(!seeds.length)return null;
 const typeCounts=new Map();for(const s of seeds){const k=s.id.split(':').slice(0,-1).join(':');typeCounts.set(k,(typeCounts.get(k)||0)+1);}
 seeds=seeds.map(s=>({...s,typeWeight:[1n,BigInt(typeCounts.get(s.id.split(':').slice(0,-1).join(':')))]}));
 let weight;try{weight=assignmentWeights(config,config.size);}catch{return null;}
 const knownWalls=new Map();for(const o of node.observations||[])if(o.kind==='walls')for(let d=0;d<4;d++)if(['墙','空'].includes(o.value[d]))knownWalls.set(E.key(o.r,o.c)+':'+d,o.value[d]);
 const knownAvailableExit=!K.A.status(built).some(p=>!p.alive&&/逃生/.test(p.reason||''));
 const traps=trapState({journal,node,config,round:a.round,player:self,steps:facts.steps});
 let horizon=remaining;
 function calculate(plans,budget){for(const plan of plans){
  const outcomes=[];
  for(const seed of seeds)for(const heart of config.heartPresence==null?[false,true]:[config.heartPresence])
   for(const row of evaluatePlan(seed,plan,{n:config.size,entry:a.entry,entryDir:facts.moves[a.step-1]?.dir,elapsed,past,config:{...config,heartPresence:heart,knownAvailableExit},steps:facts.steps,birth:node.birth,weight,budget,knownWalls,traps}))
    outcomes.push({...row,candidate:seed.id,branch:seed.cell.type==='PORTAL'?'传送':'地面'});
  if(!outcomes.length)continue;
  const total=outcomes.reduce((v,r)=>add(v,r.mass),[0n,1n]);if(!total[0])continue;
  const reward=outcomes.reduce((v,r)=>add(v,r.total),[0n,1n]),expected=divide(reward,total),num=v=>Number(v[0])/Number(v[1]);
  const collision=outcomes.filter(r=>r.wallPattern).reduce((v,r)=>add(v,r.mass),[0n,1n]);
  const weighted=outcomes.filter(r=>r.mass[0]).map(r=>{const {mass,total:reward,...rest}=r,p=divide(mass,total),u=divide(reward,mass),contribution=divide(reward,total);return {...rest,
   fraction:p.join('/'),probability:num(p),utility:num(u),utilityFraction:u.join('/'),contributionFraction:contribution.join('/'),contribution:num(contribution),
   ...(r.wallPattern?{collisionConditionalFraction:divide(mass,collision).join('/'),collisionConditionalProbability:num(divide(mass,collision))}:{})};});
  const low=Math.min(...outcomes.map(r=>r.low)),high=Math.max(...outcomes.map(r=>r.high));
  options.push({command:plan.dirs.map(d=>chars[d]).join('')+(plan.stop?'停止':''),directions:plan.dirs,stop:plan.stop,outcomes:weighted,low,high,score:num(expected),expected:expected.join('/'),scoreBasis:'local-expected-utility'});
 }}
 try{calculate(sequences(remaining),{deadline:started+650});}
 catch(error){
  if(error.message!=='LOCAL_PLAN_BUDGET'){if(input.decisionAudit)input.decisionAudit.portalError=error.message;return null;}
  options=[];horizon=1;
  try{calculate(sequences(1),{deadline:started+950});}catch{return null;}
 }
 options.sort((a,b)=>b.score-a.score||a.command.localeCompare(b.command));if(!options.length)return null;
 return {commands:options[0].directions,stop:!options[0].directions.length,score:options[0].score,round:a.round,steps:facts.steps,
  entryStep:a.step,remaining,exitStep:facts.steps+remaining,conditional:true,
  calculation:{version:3,mode:'local-model',heart:config.heartPresence,entryStep:a.step,options,
   audit:{status:'local-model',scope:'local',complete:true,globalExact:false,elapsedMs:Date.now()-started,horizon,reason:'按触及区块的抽图先验逐分支求和；未计完整全图出生权重。'+(horizon<remaining?'为避免超时已缩短到一步规划。':''),assumptions:['采用常规出生距离及非逃生舱区块约束；回退出生由完整模型处理','陷阱按实际进入次数切换；未知状态只取保守收益，不分配 50% 强停概率','未确认的机关门开闭采用等权局部先验，非完整历史后验']},
   formula:'行动分数 = Σ（局部结果概率 × 该结果的固定收益）；固定收益优先确认逃生，兼顾信息、暴露和结束行动代价',
   probabilityStatus:'这是有时间预算的局部区块模型，非完整全图贝叶斯后验；不会把部分全图枚举当作已完成概率。',
   candidates:seeds.map(s=>({id:s.id,block:s.m.id,name:s.m.block.name,row:Math.floor(s.i/3)+1,col:s.i%3+1,phase:[s.phase.pr,s.phase.pc],type:names[s.cell.type]||s.cell.type,posterior:null})),
   execution:'两步联合比较，只执行第一步；收到反馈后重新筛选、重新计算。停止分不包含墙壁信息收益。'}};
}
module.exports={portalPlans,sequences,evaluatePlan,stopValue,origins};
