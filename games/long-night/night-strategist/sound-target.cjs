'use strict';
const {E,M}=require('./kernel.cjs');

// A terminal sound can constrain the endpoint even if the route BEFORE that
// sound contains unresolved portals. This is a superset, never exact location.
function soundTargetCandidates({built,team,journal},ownRound,target){
 const self=built.self,v=built.views[self],other=built.views[target],n=v.model.config.size;
 if(!journal||v.ambiguities.length||v.localExit||team?.conflict||!built.players[target]?.alive)return null;
 const expected=target<self?ownRound:ownRound-1,last=other?.roundEnds.at(-1);
 if(!last?.complete||last.inSpace||last.round!==expected)return null;
 const node=team?.nodes?.find(x=>x.id===`${self}:${v.model.active}`);
 if(node?.verification?.status!=='verified'||node.fusionConflict||node.routePending||!node.solution?.phases?.length)return null;
 let route;
 for(const m of M.liveMessages(journal.messages))for(const t of M.parse(m.text).items)
  if(t.kind==='trajectory'&&t.player===target&&t.round===expected){
   if(!route||!t.partial||route.partial)route=t;
  }
 if(!route||route.partial||route.hidden||route.tokens.some(t=>t.kind!=='move'))return null;
 const terrain=E.terrainPossibilities(node.solution,n);
 for(const h of (v.hears||[]).slice().reverse()){
  if(h.b!==target||h.round!==expected||h.segment!==v.model.active||!h.step)continue;
  if(!['同格','正上','正下','正左','正右','左上','左下','右上','右下'].includes(h.direction))continue;
  const at=route.tokens[h.step-1],suffix=route.tokens.slice(h.step);
  // With a following collision, the speaker remained on this cell and was
  // not still advancing through subspace. Hidden/moving suffixes need replay.
  const quiet=suffix[0];
  // One successful quiet move followed by a collision rules out an entry
  // still in subspace: the next transit command could not hit a wall.
  const tracked=suffix.length===2&&quiet.outcome==='move'&&quiet.quiet&&!quiet.masked
   &&Number.isInteger(quiet.dir)&&suffix[1].outcome==='hit'&&!v.model.config.silent
   &&v.model.config.roomRules?.大乱斗==='关闭'
   &&v.hears.some(old=>old.b===target&&old.round===expected&&old.segment===h.segment&&old.step<h.step
    &&old.listener?.r===h.listener.r&&old.listener?.c===h.listener.c&&old.direction!==h.direction);
  if(!at||at.outcome!=='move'||at.masked||!['PAPA','SHASHA'].includes(at.sound)
    ||!suffix.length||(!tracked&&suffix.some(t=>t.outcome!=='hit')))continue;
  const audible=at.sound==='PAPA'?['WATER','PORTAL']:['GRASS','BERRY'];
  const positions=[];
  for(let r=0;r<n;r++)for(let c=0;c<n;c++){
   if(!E.bearings({r,c},h.listener,n).includes(h.direction))continue;
   const types=terrain.get(E.key(r,c))||[];
   if(!types.length||types.some(t=>audible.includes(t)))positions.push(tracked?{r:E.mod(r+E.V[quiet.dir][0],n),c:E.mod(c+E.V[quiet.dir][1],n)}:{r,c});
  }
  if(!positions.length||positions.length>8)continue;
  return {target,round:expected,positions,source:'sound-endpoint',exhaustive:true,
   proof:tracked?'bearing-followed-by-quiet-step':'terminal-sound-bearing',frame:`${self}:${v.model.active}`,hearing:{round:h.round,step:h.step,direction:h.direction,listener:h.listener},uncertain:true};
 }
 return null;
}
// A listener who just emerged at A can test whether the other player
// stopped at its partner B. This is a single scouting trip, never a batch
// capture or evidence of co-location.
function portalScout(input,ctx,at,round,steps){
 const {built,journal}=input,self=built.self,view=built.views[self];
 if(round<=1||steps>1||ctx.silent||!ctx.portals.size)return null;
 const target=require('./kernel.cjs').A.status(built).find(p=>p.id===self)?.target;
 if(!built.players[target]?.alive)return null;
 const expected=target<self?round:round-1,last=built.views[target].roundEnds.at(-1);
 if(!last?.complete||last.round!==expected||last.inSpace)return null;
 const previousExit=at.log.findLast(e=>e.kind==='teleport'&&e.clock?.round===round-1&&e.clock.player===self);
 if(!previousExit)return null;
 const entry=E.key(previousExit.r,previousExit.c),exit=ctx.portals.get(entry);
 if(!exit||!at.log.some(e=>e.kind==='teleport'&&e.r===exit.r&&e.c===exit.c))return null;
 const h=view.hears.findLast(h=>h.b===target&&h.round===expected&&h.segment===view.model.active);
 if(!h||E.key(h.listener.r,h.listener.c)!==entry||!E.bearings(exit,h.listener,ctx.n).includes(h.direction))return null;
 const route=M.liveMessages(journal.messages).flatMap(m=>M.parse(m.text).items.map(t=>({t,text:m.text})))
   .findLast(({t})=>t.kind==='trajectory'&&t.player===target&&t.round===expected&&!t.partial);
 if(!route||route.t.hidden||!route.text.trimEnd().endsWith('(停止)'))return null;
 const tokens=route.t.tokens,tail=tokens.slice(-3);
 if(h.step!==tokens.length||tail.length!==3||tail.some(t=>t.kind!=='move'||t.outcome!=='move'||t.masked)
    ||tail[0].sound!=='PAPA'||!tail[1].quiet||tail[2].sound!=='PAPA')return null;
 const plan=require('./pursuit.cjs').routeTo(at,exit,{...ctx,confirmedOnly:true,excludedEdges:ctx.turnEdges});
 if(plan?.risk.portalTransits!==1||plan.risk.steps!==4-steps)return null;
 // Only test this particular pair. The middle two commands take place in subspace.
 const ground=plan.commands.slice(0,-2);
 let r=at.r,c=at.c;
 for(const d of ground){r=E.mod(r+E.V[d][0],ctx.n);c=E.mod(c+E.V[d][1],ctx.n);}
 return E.key(r,c)===entry?{direction:plan.direction,entry,exit,target}:null;
}
module.exports={soundTargetCandidates,portalScout};
