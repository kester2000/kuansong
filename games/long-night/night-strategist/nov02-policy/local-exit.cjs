'use strict';
const {E,M}=require('./kernel.cjs');

function emergenceWalls(team,self,ambiguity,n){
 if(team?.conflict||ambiguity.silentUnknown||ambiguity.recoveryUnknown)return null;
 const node=team?.nodes?.find(node=>node.id===self+':'+ambiguity.segment);
 if(!node?.solution?.phases?.length||node.solution.irregular||node.verification?.status!=='verified')return null;
 const {origins}=require('../portal-plans.cjs');
 const walls=Array.from({length:4},()=>new Set());
 for(const {m,i,cell} of origins(node.solution,n,ambiguity.entry)){
  if(cell.type!=='PORTAL'||!Array.isArray(cell.portal))continue;
  const r=Math.floor(i/3)+cell.portal[0],c=i%3+cell.portal[1];
  if(r<0||r>2||c<0||c>2)continue;
  const exit=m.block.cells[r*3+c];
  for(let d=0;d<4;d++){
   const [dr,dc]=E.V[d],rr=r+dr,cc=c+dc;
   const neighbor=rr>=0&&rr<3&&cc>=0&&cc<3?m.block.cells[rr*3+cc]:null;
   if(exit.walls[d]===1||neighbor?.walls[[1,0,3,2][d]]===1)walls[d].add(m.id);
  }
 }
 return walls.map(ids=>[...ids].sort());
}

// A reversible working view, never written into the notebook or map solver.
// PAPA, one silent transit command, PAPA is compatible with portal emergence.
function localExit(input){
 const {built,journal,team}=input,self=built?.self,v=built?.views?.[self];
 if(!v||v.model.config.portalChaos||v.localExit||!v.ambiguities.length||!journal)return input;
 const a=v.ambiguities[0];
 let route;
 for(const m of M.liveMessages(journal.messages))for(const t of M.parse(m.text).items)
  if(t.kind==='trajectory'&&t.player===self&&t.round===a.round)route=t;
 if(!route?.partial||route.tokens.some(t=>t.kind==='hidden'))return input;
 const moves=route.tokens.filter(t=>t.kind==='move'),start=a.step-1;
 const pair=i=>moves[i]?.sound==='PAPA'&&!moves[i].noSubspace&&moves[i].outcome==='move'
  &&moves[i+1]?.outcome==='move'&&!moves[i+1].sound&&!moves[i+1].terrain
  &&moves[i+2]?.outcome==='move'&&moves[i+2].sound==='PAPA';
 if(!pair(start))return input;
 const view=E.clone(v),n=view.model.config.size,mid=Math.floor(n/2);
 let segment,exitStep;
 const newExit=step=>{
  segment={name:`传送出口局部假设（第${a.round}回合第${step}步）`,transition:'uncertain',events:[{kind:'observe',r:mid,c:mid,terrain:'PORTAL'}],sounds:[],anchors:[]};
  // Replace only the empty placeholder; preserve earlier local frames.
  if(!exitStep)view.model.segments[view.model.active]=segment;
  else {view.model.segments.push(segment);view.model.active=view.model.segments.length-1;}
  exitStep=step;
 };
 newExit(start+3);
 for(let i=start+3;i<moves.length;i++){
  if(pair(i)){newExit(i+3);i+=2;continue;}
  const t=moves[i];
  segment.events.push({kind:'move',dir:t.dir,outcome:t.outcome,sound:t.sound,terrain:t.terrain,
   audible:!!t.audible,masked:!!t.masked,firstSound:!!t.firstSound,
   confirmedContinues:i<moves.length-1,quiet:!!t.quiet&&!t.masked&&!view.model.config.silent,clock:{round:a.round,player:self,step:i+1}});
 }
 // Private walls belong to the latest endpoint even when its global frame is
 // unresolved. Never drop them when replacing the empty presentation frame.
 const endpoint=E.replay(segment,n);
 for(const e of v.model.segments[v.model.active].events)if(e.walls&&e.clock?.round===a.round)
  segment.events.push({...e,r:endpoint.r,c:endpoint.c});
 view.localExit={round:a.round,exitStep,steps:moves.length,assumed:true};
 // Only the first inferred pair is tied to the original entrance candidates.
 if(exitStep===start+3&&moves.length===exitStep&&v.ambiguities.length===1){
  view.localExit.walls=emergenceWalls(team,self,a,n);
 }
 // Global alignment, hearing coordinates and capture targets stay untrusted.
 const views=Array.isArray(built.views)?built.views.slice():{...built.views};views[self]=view;
 const nodes=(team?.nodes||[]).filter(node=>!node.id.startsWith(self+':')||Number(node.id.split(':')[1])<v.model.active);
 return {...input,built:{...built,views},team:{...team,nodes}};
}
function turnFacts(journal,self,round){
 let route;
 for(const m of M.liveMessages(journal?.messages||[]))for(const t of M.parse(m.text).items)
  if(t.kind==='trajectory'&&t.player===self&&t.round===round)route=t;
 const moves=(route?.tokens||[]).filter(t=>t.kind==='move');
 return {steps:moves.length,moves,exposed:moves.some(t=>t.sound&&!t.masked&&!t.firstSound&&t.direction!=='首次'&&t.direction!=='被屏蔽')};
}
// Command history remains available even when unresolved portals cut the
// spatial trace. This is a bounded no-information loop, not a map claim.
function unresolvedLoop(moves){
 // A closed command circuit can revisit random-sound tiles: differing sound
 // feedback must not make the same square walk look like perpetual progress.
 for(let period=2;period<=8;period++){
  const tail=moves.slice(-period*4);
  if(tail.length!==period*4||tail.some(t=>t.outcome!=='move'))continue;
  const cycle=tail.slice(0,period),dr=cycle.reduce((s,t)=>s+E.V[t.dir][0],0),dc=cycle.reduce((s,t)=>s+E.V[t.dir][1],0);
  if(dr===0&&dc===0&&tail.every((t,i)=>t.dir===cycle[i%period].dir))
   return {period,repetitions:4,commands:tail.map(t=>t.dir)};
 }
 // Repeating the same sound is not new evidence. Include the observations in
 // the cycle signature so a genuinely different result breaks the cycle.
 for(let period=2;period<=8;period++){
  const tail=moves.slice(-period*3);
  if(tail.length!==period*3||tail.some(t=>t.outcome!=='move'))continue;
  const signature=t=>JSON.stringify([t.dir,t.sound||'',t.terrain||'',!!t.masked]);
  if(tail.every((t,i)=>signature(t)===signature(tail[i%period])))
   return {period,repetitions:3,commands:tail.map(t=>t.dir)};
 }
 const straight=moves.slice(-9);
 if(straight.length===9&&straight.every(t=>t.outcome==='move'&&t.dir===straight[0].dir))
  return {period:1,repetitions:9,commands:straight.map(t=>t.dir)};
 for(let period=1;period<=8;period++){
  const repetitions=period===1?3:2;
  if(moves.length<period*repetitions)continue;
  const tail=moves.slice(-period*repetitions),recent=tail.slice(period);
  if(tail.some(t=>t.outcome!=='move')||recent.some(t=>t.sound||t.terrain))continue;
  if(recent.every((t,i)=>t.dir===tail[i%period].dir))
   return {period,repetitions,commands:tail.map(t=>t.dir)};
 }
 return null;
}
module.exports={localExit,turnFacts,unresolvedLoop};
