'use strict';
const {E,M}=require('./kernel.cjs');

// A reversible working view, never written into the notebook or map solver.
// PAPA, one silent transit command, PAPA is compatible with portal emergence.
function localExit(input){
 const {built,journal,team}=input,self=built?.self,v=built?.views?.[self];
 if(!v||v.model?.config?.portalChaos||v.localExit||!v.ambiguities.length||!journal)return input;
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
 return {steps:moves.length,moves,continuous:!!route?.partial&&!route.tokens.some(t=>t.kind!=='move'),exposed:moves.some(t=>t.sound&&!t.masked&&!t.firstSound&&t.direction!=='首次'&&t.direction!=='被屏蔽')};
}
// Command history remains available even when unresolved portals cut the
// spatial trace. This is a bounded no-information loop, not a map claim.
function unresolvedLoop(moves){
 for(let period=2;period<=8;period++){
  if(moves.length<period*2)continue;
  const tail=moves.slice(-period*2),recent=tail.slice(period);
  if(tail.some(t=>t.outcome!=='move')||recent.some(t=>t.sound||t.terrain))continue;
  if(recent.every((t,i)=>t.dir===tail[i].dir)&&new Set(recent.map(t=>t.dir)).size>1)
   return {period,repetitions:2,commands:tail.map(t=>t.dir)};
 }
 return null;
}
module.exports={localExit,turnFacts,unresolvedLoop};
