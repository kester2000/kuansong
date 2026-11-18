'use strict';
const {E}=require('./kernel.cjs'),Timeline=require('../vendor/long-night/timeline.js');
function canonical(r,c,d,n){const a=E.mod(r,n)*n+E.mod(c,n),b=E.mod(r+E.V[d][0],n)*n+E.mod(c+E.V[d][1],n);return a<b?a+':'+b:b+':'+a;}
function currentDoors(config,solution,knownBlocks,observations,clock){
 const n=config.size,placements=knownBlocks.map(b=>({...b,block:E.byId.get(b.id)})).filter(b=>b.block);
 // A possible door in an unidentified block is still dynamic. A past pass
 // can precede a button press on arrival, so it cannot certify the reverse
 // edge. Retain these edges as unknown until their timeline is provable.
 const kinds=require('./edge-kinds.cjs').edgeKinds(config,solution);
 for(const [edge,ks] of E.inferredWallKinds(config,solution,knownBlocks))kinds.set(edge,ks);
 const doors=new Map(),edges=new Map(),buttons=new Map();
 const relevant=ks=>ks.every(k=>k===3||k===4)||config.dynamicDoors&&ks.some(k=>k===3||k===4);
 if(![...kinds.values()].some(relevant))return {doors,edges,buttons};
 if(!clock){const timed=observations.filter(o=>o.clock?.round>0).map(o=>o.clock).sort((a,b)=>a.round-b.round||a.player-b.player||a.step-b.step);clock=timed.at(-1)||{round:1,player:0,step:0};}
 // A block need not be identified to prove that a visited cell is not a
 // button. Do not erase every door merely because that unrelated ID is open.
 const nonButtons=new Set(),corridors=new Set();
 if(solution.phases.length)for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(solution.phases.every(p=>E.phaseAt(p,n,r,c).slot<0))corridors.add(r*n+c);
 for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(solution.phases.every(p=>{const {slot,i}=E.phaseAt(p,n,r,c);return p.domains[slot].every(m=>m.block.cells[i].attach!=='BUTTON');}))nonButtons.add(r*n+c);
 const result=Timeline.check(config,placements,observations,true,{...clock,nonButtons,corridors});
 // Conditional templates can also agree on the current edge (for example,
 // solid wall versus a door observed closed after the last button press).
 // Check each domain member, never select one template as the true layout.
 const conditional=new Map();
 function candidateState(r,c,d,key){
  const states=new Set();
  for(const [pi,p] of solution.phases.entries()){
   const a=E.phaseAt(p,n,r,c),b=E.phaseAt(p,n,E.mod(r+E.V[d][0],n),E.mod(c+E.V[d][1],n));
   if(a.slot<0||a.slot!==b.slot)return 'unknown';
   for(const m of p.domains[a.slot]){
    const raw=Math.max(m.block.cells[a.i].walls[d],m.block.cells[b.i].walls[E.OPP[d]]);
    if(raw!==3&&raw!==4){states.add(raw===0?'open':raw===1?'closed':'unknown');continue;}
    const origin=m.origin||p.slots[a.slot],id=pi+':'+origin.r+','+origin.c+':'+m.id;
    if(!conditional.has(id)){
     const chosen=placements.filter(x=>x.origin.r!==origin.r||x.origin.c!==origin.c);
     chosen.push({...m,origin,block:m.block});
     conditional.set(id,Timeline.check(config,chosen,observations,true,{...clock,nonButtons,corridors}));
    }
    const check=conditional.get(id);states.add(check.valid?check.doorStates?.[key]||'unknown':'unknown');
   }
  }
  return states.size===1?[...states][0]:'unknown';
 }
 for(const [edge,ks] of kinds){if(!relevant(ks))continue;const [r,c,d]=edge.split(/[,:]/).map(Number),key=canonical(r,c,d,n),certain=ks.every(k=>k===3||k===4);
  if(doors.has(key)){edges.set(edge,key);continue;}
  let state=!certain?'unknown':!config.dynamicDoors&&ks.length===1?(ks[0]===3?'closed':'open'):result.valid?result.doorStates?.[key]||'unknown':'unknown';
  if(state==='unknown'&&config.dynamicDoors)state=candidateState(r,c,d,key);
  if(!doors.has(key))doors.set(key,{state,index:doors.size,source:certain?'button-timeline':'possible-door'});
  edges.set(edge,key);
 }
 for(const m of placements)for(let i=0;i<9;i++){
  const cell=m.block.cells[i];if(cell.attach!=='BUTTON')continue;
  const r=E.mod(m.origin.r+Math.floor(i/3),n),c=E.mod(m.origin.c+i%3,n);let mask=0n,complete=true;
  for(const [dr,dc,dir] of cell.buttons||[]){const d={UP:0,DOWN:1,LEFT:2,RIGHT:3}[dir];if(d==null){complete=false;continue;}const key=canonical(r+dr,c+dc,d,n),door=doors.get(key);
   if(door)mask^=1n<<BigInt(door.index);else complete=false;
  }
  if(complete)buttons.set(E.key(r,c),mask);
 }
 return {doors,edges,buttons,valid:result.valid};
}
function applyDoors(ctx,board){
 const model=currentDoors(ctx.config,ctx.solution,ctx.node?.verification?.blocks||[],ctx.node?.walkingObservations||ctx.node?.mergedObservations||ctx.at.observations,{round:ctx.round,player:ctx.self,step:ctx.steps});
 // Use the same current edge evidence that the command sender sees. Keep
 // door identities and button masks so route search can still model toggles.
 if(board?.n===ctx.n){
  const sides=['u','d','l','r'];
  for(const [r,row] of board.cells.entries())for(const [c,cell] of row.entries()){
   for(const [d,side] of sides.entries()){
    const edge=E.key(r,c)+':'+d;
    const wall=cell[side],kind=cell.wallKinds?.[side];
    const door=model.doors.get(model.edges.get(edge));
    if(door&&cell.doors?.[side]){
     door.state=cell.doors[side].state;
     if(wall==='墙'&&door.state==='unknown')door.blockedByBoard=true;
    }else if(wall==='墙'||wall==='空'){
     ctx.walls.set(edge,wall);
     if(kind!=null)ctx.wallKinds.set(edge,[kind]);
    }
   }
  }
 }
 ctx.doorModel=model;
 // The arena calls the policy without a rendered board. Preserve the same
 // reported-closed guard there: an unidentified possible door is not a reason
 // to retry an observed wall every turn. A proven later switch to open still
 // takes precedence; do not turn this guard into a permanent map constraint.
 for(const {r,c,d} of require('./reported-walls.cjs').reportedClosed(ctx.at,ctx.n).values()){
  const door=model.doors.get(model.edges.get(E.key(r,c)+':'+d));
  if(door?.state==='unknown')door.blockedByObservation=true;
 }
 for(const [edge,key] of model.edges){const state=model.doors.get(key).state;
  ctx.wallKinds.set(edge,state==='open'?[4]:state==='closed'?[3]:[3,4]);
  if(state==='unknown')ctx.walls.delete(edge);else ctx.walls.set(edge,state==='open'?'空':'墙');
 }
 return model;
}
module.exports={currentDoors,applyDoors,canonical};
