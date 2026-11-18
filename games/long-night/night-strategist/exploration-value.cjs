'use strict';
const {E}=require('./kernel.cjs');
function address(p,n,r,c){
 return E.phaseAt(p,n,r,c);
}
// Birth and already identified non-exit blocks remain usable as corridors.
// They do not earn the reward for looking for an escape block again.
function regionValue(ctx,to){
 const phases=ctx.solution?.phases||[];
 if(!phases.length||ctx.solution.irregular)return {birth:false,noExit:false,button:false,discount:0};
 const birth=!!ctx.birth&&phases.every(p=>address(p,ctx.n,to.r,to.c).slot===address(p,ctx.n,ctx.birth.r,ctx.birth.c).slot);
 const noExit=phases.every(p=>p.domains[address(p,ctx.n,to.r,to.c).slot].every(m=>!m.block.cells.some(c=>c.type==='EXIT')));
 const button=phases.some(p=>{const a=address(p,ctx.n,to.r,to.c);return p.domains[a.slot].some(m=>m.block.cells[a.i].attach==='BUTTON');});
 return {birth,noExit,button,discount:birth?6:noExit?3:0};
}
function buttonCost(ctx,to){return regionValue(ctx,to).button?14:0;}
module.exports={address,regionValue,buttonCost};
