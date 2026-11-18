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
  if(!at||at.outcome!=='move'||at.masked||!['PAPA','SHASHA'].includes(at.sound)
    ||!suffix.length||suffix.some(t=>t.outcome!=='hit'))continue;
  const audible=at.sound==='PAPA'?['WATER','PORTAL']:['GRASS','BERRY'];
  const positions=[];
  for(let r=0;r<n;r++)for(let c=0;c<n;c++){
   if(!E.bearings({r,c},h.listener,n).includes(h.direction))continue;
   const types=terrain.get(E.key(r,c))||[];
   if(!types.length||types.some(t=>audible.includes(t)))positions.push({r,c});
  }
  if(!positions.length||positions.length>8)continue;
  return {target,round:expected,positions,source:'sound-endpoint',exhaustive:true,
   proof:'terminal-sound-bearing',frame:`${self}:${v.model.active}`,hearing:{round:h.round,step:h.step,direction:h.direction,listener:h.listener},uncertain:true};
 }
 return null;
}
module.exports={soundTargetCandidates};
