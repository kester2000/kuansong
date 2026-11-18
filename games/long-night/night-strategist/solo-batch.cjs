'use strict';
const {E}=require('./kernel.cjs'),P=require('./objective-policy.cjs'),{edgeState}=require('./movement.cjs');
function apply(input,s){
 if(input.built?.count!==1||!s?.ok||!s.primary||s.primary.blocked)return s;
 const ctx=P.context(input);
 if(!ctx?.certain||ctx.uncertainLocation||ctx.warnings.length||ctx.config.event!=='NONE'||ctx.config.brawl
   ||ctx.rules.大乱斗==='开启'||ctx.rules.BOSS&&ctx.rules.BOSS!=='无'||Number(ctx.rules.炸弹)>0||ctx.rules.谋定后动==='开启')return s;
 if(s.tactic?.kind==='escape'){
  const objective=P.plan(ctx);
  return objective?.tactic?.kind==='escape'&&objective.tactic.batchEscape?.confirmed?objective:s;
 }
 if(!['bounded-exploration','continue-exploration','required-transit'].includes(s.tactic?.kind))return s;
 const route=s.primary.evaluation?.path;
 if(!route?.length||route[0]!==s.primary.dirIndex)return s;
 let p={...ctx.from},last=ctx.lastDirection;const prefix=[];
 for(const d of route){
  const edge=edgeState(p,d,ctx,last);if(edge.blocked)break;
  const to={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)};
  prefix.push(d);p=to;last=d;
  const facts=P.features(ctx,to);
  // The final probe may reveal new information. Every intermediate command
  // has identical, already-known feedback in all compatible map candidates.
  if(edge.uncertain||edge.wall!=='空'||!ctx.visited.has(E.key(to.r,to.c))
    ||facts.types.length!==1||facts.types[0]!=='EMPTY'||[...facts.attachments].some(a=>a!=='EMPTY'))break;
 }
 if(prefix.length<2)return s;
 const commands=prefix.map(d=>'上下左右'[d]).join('');
 return {...s,primary:{...s.primary,reasons:[`已知通路的中途反馈不会改变选择，一次发送 ${commands}；末端反馈后重算`,...s.primary.reasons]},
  tactic:{...s.tactic,kind:'solo-prefix',round:ctx.round,steps:ctx.steps,batchRoute:{confirmed:true,commands,target:p,proof:'known-empty-intermediate-cells'}}};
}
module.exports={apply};
