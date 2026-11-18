'use strict';
const {E,M}=require('./kernel.cjs');
const {edgeState}=require('./movement.cjs');
const names=['up','down','left','right'],chars='上下左右',key=p=>E.key(p.r,p.c);
const cellNames=['左上','正上','右上','正左','中央','正右','左下','正下','右下'];
function rules(config){const r=config.roomRules||{};return {deliberate:config.deliberate??r.谋定后动==='开启',bombs:Number(r.炸弹||0)>0||/邦邦/.test(r.BOSS||''),boss:r.BOSS==='无'?'':r.BOSS||'',hidden:r.隐匿||'关闭'};}
function laws(journal,round){
 const out=new Map();let current=0;
 for(const m of M.liveMessages(journal?.messages||[])){
  const text=m.text,rm=text.match(/【第\s*(\d+)\s*回合】/);if(rm)current=+rm[1];
  if(current!==round||!/暴君/.test(text))continue;
  const boss=text.match(/暴君(?:[A-Z0-9]+)?/)?.[0]||'暴君';
  if(/本回合.*(?:失效|铁律失效)|本回合失效/.test(text)){out.delete(boss);continue;}
  const mLaw=text.match(/「(禁足|活动|噤声|仁爱|牢笼|戒严)」([^\n]*)/);if(!mLaw)continue;
  const limit=mLaw[2].match(/(\d+)\s*步/),cells=cellNames.flatMap((name,i)=>mLaw[2].includes(name)?[i]:[]);
  out.set(boss,{boss,kind:mLaw[1],limit:limit?+limit[1]:null,cells});
 }
 return [...out.values()];
}
function bombState(observations,self,round){
 const bombs=new Set();let armed=false;
 const sorted=observations.filter(o=>o.clock).slice().sort((a,b)=>a.clock.round-b.clock.round||a.clock.player-b.clock.player||a.clock.step-b.clock.step||(a.index??0)-(b.index??0));
 for(const o of sorted){
  const k=key(o);
  if(o.kind==='bomb'){if(o.value)bombs.add(k);else bombs.delete(k);}
  if(o.kind==='action'&&o.arrival&&o.clock.player===self&&o.clock.round===round)armed=bombs.has(k);
  if(o.kind==='turnEnd'&&o.clock.player===self&&o.clock.round===round)armed=false;
 }
 return {bombs,armed};
}
function hiddenState(journal,self,round){
 let active=false,mode=null;let current=0;
 for(const m of M.liveMessages(journal?.messages||[])){
  const rm=m.text.match(/【第\s*(\d+)\s*回合】/);if(rm)current=+rm[1];
  if(current!==round)continue;
  // Only an explicitly self-addressed confirmation authorizes private routing.
  const addressed=m.view===self&&(m.source?.key?.startsWith('private:')||m.source?.addressedToSelf===true)||new RegExp('\\['+self+'号\\][^\\n]*使用隐匿技能').test(m.text);
  if(addressed&&/使用隐匿技能/.test(m.text)){active=true;mode=/下一步/.test(m.text)?'STEP':'TURN';}
  for(const route of M.parse(m.text).items.filter(i=>i.kind==='trajectory'&&i.player===self)){
   if(!route.partial)active=false;
   else if(active&&mode==='STEP'&&m.source?.key?.startsWith('private:')&&route.tokens.some(t=>t.kind==='move'))active=false;
  }
 }
 return {active,mode};
}
function canStopForMode(s){return s?.tactic?.kind==='mode-stop'&&['armed-bomb','tyrant-limit','tyrant-silence'].includes(s.tactic.reason)&&s.tactic.verified===true;}
function stop(s,ctx,reason,text){return {...s,primary:{direction:'stop',label:'停止',wall:'空',blocked:false,reasons:[text],gains:[],risks:[]},alternatives:[],tactic:{kind:'mode-stop',reason,verified:true,round:ctx.round,steps:ctx.steps},mode:{...s.mode,reason}};}
function destinationAllowed(ctx,p,activeLaws){
 return activeLaws.every(l=>l.kind!=='戒严'||ctx.solution?.phases?.length&&ctx.solution.phases.every(ph=>{const a=E.phaseAt(ph,ctx.n,p.r,p.c);return a.slot<0||!l.cells.includes(a.i);}));
}
function deliberatePlan(ctx,moves,activeLaws=[],bombs=new Set(),maxDepth=12){
 const queue=[{...ctx.from,path:[],last:ctx.lastDirection,mask:0n,seen:new Set([key(ctx.from)])}],options=[];
 // An uncertain door remains uncertain for movement/batch safety. Crossing an
 // already observed edge back to known terrain is not fresh exploration merely
 // because its possible switch state is unresolved again in the next round.
 const passed=new Set();
 if(!ctx.uncertainLocation)for(const o of ctx.at?.observations||[])if(o.kind==='pass'){
  passed.add(E.key(o.r,o.c)+':'+o.dir);
  passed.add(E.key(E.mod(o.r+E.V[o.dir][0],ctx.n),E.mod(o.c+E.V[o.dir][1],ctx.n))+':'+E.OPP[o.dir]);
 }
 let visited=0;
 while(queue.length&&visited++<500){const p=queue.shift();
  for(let d=0;d<4;d++){
   if(!p.path.length&&!moves.some(m=>m.dirIndex===d&&!m.blocked))continue;
   const edge=edgeState(p,d,ctx,p.last,p.mask);if(edge.blocked)continue;
   const to={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)},k=key(to),ts=ctx.terrain.get(k)||[],path=[...p.path,d];
   const needsMovement=activeLaws.some(l=>l.kind==='活动'&&ctx.successfulMoves+p.path.length<l.limit);
   if(bombs.has(k)||p.seen.has(k)&&!needsMovement)continue;
   const plain=ts.length&&ts.every(t=>t==='EMPTY'),quiet=plain||ctx.silent&&ts.length&&ts.every(t=>['WATER','GRASS','BERRY'].includes(t));
   const onTarget=ctx.target&&key(ctx.target)===k&&ctx.round>1;
   if(activeLaws.some(l=>l.kind==='噤声'&&!quiet||l.kind==='牢笼'&&ctx.config?.brawl&&ts.includes('EXIT')||l.kind==='仁爱'&&onTarget||l.kind==='禁足'&&ctx.successfulMoves+path.length>l.limit))continue;
   const endpoint=destinationAllowed(ctx,to,activeLaws),enough=activeLaws.every(l=>l.kind!=='活动'||ctx.successfulMoves+path.length>=l.limit);
   const unknown=edge.wall!=='空'||edge.uncertain||!ts.length||ts.length>1;
   const newFeedback=unknown&&(!passed.has(key(p)+':'+d)||ts.length!==1);
   const exit=ctx.exits.cells.has(k),target=ctx.target&&key(ctx.target)===k&&ctx.round>1&&!activeLaws.some(l=>l.kind==='仁爱');
   // An uncertain final edge may collide: it cannot satisfy a mandatory move.
   const movementGuaranteed=activeLaws.every(l=>l.kind!=='活动'||ctx.successfulMoves+path.length-(edge.wall!=='空'||edge.uncertain?1:0)>=l.limit);
   if(endpoint&&enough&&movementGuaranteed){const first=moves.find(m=>m.dirIndex===path[0]);options.push({path,to,score:(first?.score||0)*0.1+(exit?100:0)+(target?110:0)+(newFeedback?12:!ctx.visited.has(k)?5:0)-path.length*0.4-(quiet?0:10)});}
   // A batch continues only through proven plain terrain, certain edges and
   // no buttons. Its last probe may be unknown and is never used as evidence.
   const button=ctx.doorModel?.buttons.has(k)||ctx.solution?.phases?.some(ph=>{const a=E.phaseAt(ph,ctx.n,to.r,to.c);return (ph.domains[a.slot]||[]).some(m=>m.block.cells[a.i].attach!=='EMPTY');});
   if(path.length<maxDepth&&plain&&!button&&!unknown&&!exit&&!target)queue.push({...to,path,last:d,mask:p.mask,seen:new Set([...p.seen,k])});
  }
 }
 return options.sort((a,b)=>b.score-a.score||a.path.length-b.path.length)[0]||null;
}
function apply(input,s){
 if(!s?.ok)return s;
 const config=input.built.views[input.built.self].model.config,r=rules(config);
 if(!r.deliberate&&!r.bombs&&!r.boss&&r.hidden==='关闭')return s;
 const ctx=require('./objective-policy.cjs').context(input);if(!ctx)return s;
 const activeLaws=laws(input.journal,ctx.round),bomb=bombState(ctx.node?.mergedObservations||ctx.node?.observations||[],ctx.self,ctx.round),hidden=hiddenState(input.journal,ctx.self,ctx.round);
 ctx.successfulMoves=(ctx.facts.moves||[]).filter(t=>t.outcome==='move').length;
 s={...s,mode:{deliberate:r.deliberate,hidden,law:activeLaws,bombLocations:[...bomb.bombs],bossTracking:r.boss?'partial':null}};
 if(bomb.armed)return stop(s,ctx,'armed-bomb','已踩中已知炸弹：继续尝试移动会引爆，停止拆弹');
 if(activeLaws.some(l=>l.kind==='禁足'&&ctx.successfulMoves>=l.limit))return stop(s,ctx,'tyrant-limit','本回合成功移动已达到暴君禁足上限');
 const forbid=m=>{
  if(bomb.bombs.has(key(m.to||{})))return true;
  const ts=ctx.terrain.get(key(m.to||{}))||[];
  return activeLaws.some(l=>l.kind==='噤声'&&!ctx.silent&&!hidden.active&&(!ts.length||ts.some(t=>E.soundTypes(t,config.event).some(s=>s!=='NONE')))||l.kind==='牢笼'&&config.brawl&&ts.includes('EXIT')||l.kind==='仁爱'&&ctx.target&&key(m.to||{})===key(ctx.target));
 };
 const moves=(s.moves||[]).map(m=>forbid(m)?{...m,blocked:true,modeForbidden:true}:m),allowed=moves.filter(m=>!m.blocked);
 if(s.primary&&forbid(s.primary))s={...s,primary:allowed.sort((a,b)=>b.score-a.score)[0]||null,alternatives:[],tactic:{kind:'mode-explore',round:ctx.round,steps:ctx.steps}};
 s.moves=moves;
 // An older multi-step capture/escape plan has not been checked against laws.
 if(activeLaws.length)s={...s,tactic:{kind:'mode-single',round:ctx.round,steps:ctx.steps},plan:null};
 if(!s.primary&&activeLaws.some(l=>l.kind==='噤声'))return stop(s,ctx,'tyrant-silence','没有可证明不发声的移动，停止以遵守噤声铁律');
 if(hidden.active){s={...s,primary:s.primary?.direction==='stop'?allowed[0]||null:s.primary,tactic:{kind:'mode-single',round:ctx.round,steps:ctx.steps},plan:null};return s;}
 if(r.deliberate){
  // A verified wall-ending is already a complete one-command deliberate turn.
  // Do not discard it just because there is no traversable batch; combinations
  // with active boss laws still go through their own stricter checks.
  if(!activeLaws.length&&require('./action-rules.cjs').trappedFinish(s))return s;
  const plan=deliberatePlan(ctx,moves,activeLaws,bomb.bombs,r.bombs?1:12);
  if(plan){const primary=moves.find(m=>m.dirIndex===plan.path[0]);s={...s,primary,alternatives:[],plan:null,tactic:{kind:'deliberate-batch',round:ctx.round,steps:ctx.steps,batchRoute:{confirmed:true,commands:plan.path.map(d=>chars[d]).join(''),target:plan.to}}};}
  else s={...s,primary:null,alternatives:[],plan:null,tactic:{kind:'mode-unresolved',round:ctx.round,steps:ctx.steps},mode:{...s.mode,reason:'没有找到满足组合规则的可验证行动'}};
 }else if(r.bombs&&s.primary){
  // Unknown bomb placements require feedback after each arrival. Explicitly
  // known bombs were excluded above; never carry an old multi-step tactic.
  s={...s,tactic:{kind:'mode-single',round:ctx.round,steps:ctx.steps},plan:null};
 }
 return s;
}
module.exports={apply,rules,laws,bombState,hiddenState,canStopForMode,deliberatePlan,destinationAllowed};
