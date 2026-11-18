'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {E}=require('./kernel.cjs'),{buildWorld}=require('./bayes-worlds.cjs');
const VERSION='particles-20261106-v1';
const names={EMPTY:'空地',GRASS:'沙沙（草丛）',WATER:'啪嗒（水洼）',BERRY:'沙沙（浆果丛）',TRAP:'陷阱',PORTAL:'啪嗒（传送门）',ONEWAYPORTAL:'啪嗒（单向门）',EXIT:'逃生舱',HEART:'心脏',HEAT:'热源'};
function reason(ctx){
 if(!ctx.input?.journal||!ctx.birth||ctx.view.model.active!==0||ctx.uncertainLocation||ctx.warnings?.length)return '当前位置或出生轨迹未完整确定';
 if(ctx.n!==9||!ctx.solution?.phases?.length||ctx.solution.irregular)return '暂只支持规则九宫格';
 const c=ctx.config,r=ctx.rules||{};
 if(!Number.isInteger(c.exitCount)||!Number.isInteger(c.playerCount)||c.playerCount<1||c.playerCount>8)return '人数或逃生舱数量未知';
 if(c.event&&c.event!=='NONE'||c.brawl||r.教程==='开启'||r.摸黑==='开启'||r.隐匿&&r.隐匿!=='关闭'||r.BOSS||Number(r.炸弹)>0)return '特殊模式尚未通过采样校验';
 if(!c.pool?.trim()&&c.mode!=='CLASSIC')return '实际候选区块池尚未识别';
 const pool=E.pool({...c,heartPresence:null});
 if(pool.some(b=>b.cells.some(x=>['BOX','HEATBOX','JAMMERBOX','BOMB'].includes(x.attach))))return '箱子或炸弹动态尚未纳入此版';
 if(pool.some(b=>b.cells.some(x=>x.attach==='BUTTON'))&&!ctx.solo&&(ctx.round!==1||ctx.self!==0))return '其他玩家可能改变门状态，此版不臆造其概率';
 return null;
}
function request(ctx,options={}){
 const unsupported=reason(ctx);if(unsupported)return {status:'fallback',reason:unsupported};
 const config=ctx.config,node=ctx.node,observations=node.mergedObservations||node.observations||ctx.at.observations;
 const births=(node.joined||[{id:node.id,dr:0,dc:0}]).flatMap(j=>{const n=ctx.input.team.nodes.find(n=>n.id===j.id);return n?.birth?[{r:E.mod(n.birth.r+j.dr,9),c:E.mod(n.birth.c+j.dc,9),player:n.player}]:[];});
 if(!births.some(b=>b.player===ctx.self))return {status:'fallback',reason:'缺少可验证出生坐标'};
 const session=ctx.input.journal.meta?.createdAt||ctx.input.journal.meta?.title||JSON.stringify(ctx.input.journal.messages?.[0]||'');
 const key=crypto.createHash('sha256').update(JSON.stringify([session,config.pool,config.mode,config.playerCount,births])).digest('hex');
 const dir=path.join(require('./store.cjs').dataDir(),'particle-cache');fs.mkdirSync(dir,{recursive:true});
 // Bound disk use; no journals or actual game maps are stored in this cache.
 const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>({f,t:fs.statSync(path.join(dir,f)).mtimeMs})).sort((a,b)=>b.t-a.t);
 for(const f of files.slice(16))fs.unlinkSync(path.join(dir,f.f));
 const q={config,observations,births,session,seed:JSON.stringify([key,observations]),cache:path.join(dir,key+'.json'),
  phases:ctx.solution.phases.map(p=>({pr:p.pr,pc:p.pc,slots:p.domains.map(d=>d[0].origin),domains:p.domains.map(d=>d.map(m=>m.id))})),
  budgetMs:300,maxTrials:10000,target:1024,minEss:96,...options};
 const worker=cp.spawnSync(process.execPath,[path.join(__dirname,'particle-worker.cjs')],{input:JSON.stringify(q),encoding:'utf8',timeout:q.budgetMs+450,maxBuffer:16e6,windowsHide:true});
 if(worker.error||worker.status!==0)return {status:'fallback',reason:'采样进程达到时间上限或未正常完成'};
 let result;try{result=JSON.parse(worker.stdout);}catch{return {status:'fallback',reason:'采样进程输出无效'};}
 if(result.error)return {status:'fallback',reason:'采样校验失败：'+result.error};
 const a=result.audit;
 if(!(a.ess>=64&&a.distinct>=32&&a.maxWeight<=0.1))return {status:'fallback',reason:'有效样本或多样性不足，继续使用目标策略',...a};
 return {status:'estimated',...a,rows:result.rows};
}
function worlds(ctx,rows){return rows.map(row=>{
 const phase=ctx.solution.phases.find(p=>p.pr===row.pr&&p.pc===row.pc),selected=row.ids.map((id,i)=>phase.domains[i].find(m=>m.id===id));
 const world=buildWorld(phase,selected,9);
 // Sealed paired portals become one-way portals during map initialization.
 const converted=new Set();world.cells.forEach((c,i)=>{if(c.type==='PORTAL'&&world.walls[i].every(w=>[1,3,4].includes(w))&&c.portal){converted.add(i);converted.add(E.mod(Math.floor(i/9)+c.portal[0],9)*9+E.mod(i%9+c.portal[1],9));}});
 world.cells=world.cells.map((c,i)=>converted.has(i)?{...c,type:'ONEWAYPORTAL'}:c);
 // Buttons are supported only on our uninterrupted first turn (self=0).
 // The original wall array remains the birth prior; modify only prediction.
 const actions=new Map();for(const o of ctx.at.observations)if(o.kind==='action'&&o.arrival&&o.clock)actions.set([o.clock.round,o.clock.player,o.clock.step].join(':'),o);
 for(const o of actions.values()){
  const cell=world.cells[o.r*9+o.c];if(cell.attach!=='BUTTON')continue;
  for(const [dr,dc,dir] of cell.buttons||[]){const d={UP:0,DOWN:1,LEFT:2,RIGHT:3}[dir],i=E.mod(o.r+dr,9)*9+E.mod(o.c+dc,9),j=world.next(i,d),k=world.walls[i][d];if(k===3||k===4)world.walls[i][d]=world.walls[j][E.OPP[d]]=7-k;}
 }
 return {world,weight:row.weight};
});}
function outcome(ctx,w,d){
 const i=ctx.from.r*9+ctx.from.c,j=w.next(i,d),wall=w.walls[i][d],cell=w.cells[j];
 if(wall===1||wall===3||wall===2&&ctx.lastDirection!==d){const shape=w.walls[i].map(E.wallFeedback).join('');return {label:'撞墙 · '+shape,wallPattern:shape,risk:20,collision:true};}
 const masked=w.heart&&ctx.steps+1<=19&&(ctx.steps+1)%3===1;
 const trap=cell.type==='TRAP'?require('./trap-state.cjs').trapArrival(ctx.trapState,{r:Math.floor(j/9),c:j%9}):null;
 const sound=['WATER','GRASS','BERRY','PORTAL','ONEWAYPORTAL'].includes(cell.type)||trap&&!trap.active;
 let risk=sound&&!ctx.solo&&!ctx.silent&&!masked?6+Math.min(3,ctx.progress.turnSounds.size)*4:0;
 if(cell.type==='PORTAL')risk+=ctx.portals.has(E.key(Math.floor(j/9),j%9))?6:16;
 if(trap?.active)risk+=42;
 if(cell.type==='HEAT')risk+=35;if(cell.type==='HEART')risk+=60;if(cell.attach==='BUTTON')risk+=12;
 const label=(trap?(trap.uncertain?'陷阱（停步状态未知，按不利风险评分）':trap.active?'陷阱触发停步':'沙沙（首次踩陷阱）'):(names[cell.type]||cell.type))+(sound?(ctx.silent?' · 静音':masked?' · 心跳掩盖':''):'');
 return {label,risk};
}
function apply(ctx,moves,edgeCost){
 let result;try{result=request(ctx);}catch(e){result={status:'fallback',reason:'采样暂不可用：'+e.message};}
 ctx.particles={...result};delete ctx.particles.rows;
 if(result.status!=='estimated')return;
 const samples=worlds(ctx,result.rows),total=samples.reduce((s,x)=>s+x.weight,0);
 // Same worlds for all four actions. Preserve confirmed escape/capture and
 // diagnostic priorities; only replace immediate exploration risk estimates.
 for(const move of moves){
  if(move.blocked||move.tactic||!move.route?.length||move.route.length!==1)continue;
  const old=edgeCost(ctx,ctx.from,move.dirIndex,ctx.lastDirection).components;
  const replace=['边界未确定','地形不确定风险','暴露风险','传送代价','可能强停','热源风险','心脏阻挡','地形未知','按钮公示与改门'];
  const oldRisk=-replace.reduce((s,k)=>s+(old[k]||0),0),base=move.score+oldRisk,groups=new Map();
  for(const {world,weight} of samples){const o=outcome(ctx,world,move.dirIndex),g=groups.get(o.label)||{label:o.label,wallPattern:o.wallPattern,mass:0,sum:0};const lost=o.collision?['新格探索','寻找出口区域','进入新区块','金币'].reduce((s,k)=>s+(move.components[k]||0),0):0;g.mass+=weight;g.sum+=weight*(base-o.risk-lost);groups.set(o.label,g);}
  const outcomes=[...groups.values()].map(g=>({label:g.label,wallPattern:g.wallPattern,probability:g.mass/total,utility:g.sum/g.mass,contribution:g.sum/total}));
  const score=outcomes.reduce((s,o)=>s+o.contribution,0),delta=score-move.score;
  move.components={...move.components,采样预期风险修正:delta};move.score=Object.values(move.components).reduce((s,v)=>s+v,0);move.outcomes=outcomes;
  move.reasons.push('根据 '+result.samples+' 个加权地图样本估计下一步风险；有效样本 '+Math.round(result.ess)+'，并非精确概率或胜率');
 }
 const positions=new Map();samples.forEach(({world,weight},index)=>{const p=ctx.birth,i=p.r*9+p.c,slot=world.slots[i],row=result.rows[index];const id=row.ids[slot];const r=E.mod(p.r-row.pr,3)+1,c=E.mod(p.c-row.pc,3)+1,k=id+':'+r+':'+c;const old=positions.get(k)||{block:id,name:E.byId.get(id).name,row:r,col:c,probability:0};old.probability+=weight/total;positions.set(k,old);});
 ctx.particles.positions=[...positions.values()].sort((a,b)=>b.probability-a.probability);
}
module.exports={VERSION,reason,request,apply,outcome,worlds};
