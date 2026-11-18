'use strict';
const {E}=require('./kernel.cjs'),{edgeState}=require('./movement.cjs');
const KINDS=new Set(['bounded-exploration','quiet-exploration-before-candidates','escape','pursue']);
// The endpoint is still a separate observation/decision. Only previously
// traversed, unanimously empty cells with no attachments may be skipped over.
function confirmedPrefix(ctx,path,max=12){
 if(!ctx.certain||!ctx.solution?.phases?.length||ctx.solution.irregular||ctx.uncertainLocation)return null;
 const visited=new Set((ctx.at.trace||[]).map(p=>E.key(p.r,p.c))),commands=[];
 const prefixVisited=new Set([E.key(ctx.from.r,ctx.from.c)]);
 let p={...ctx.from},last=ctx.lastDirection;
 for(const d of path.slice(0,max)){
  if(!Number.isInteger(d)||d<0||d>3)break;
  const edge=edgeState(p,d,ctx,last);
  if(edge.blocked||edge.uncertain||edge.wall!=='空')break;
  const to={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)};
  const key=E.key(to.r,to.c);
  if(!visited.has(key)||prefixVisited.has(key))break;
  if(!ctx.solution.phases.every(phase=>{
   const at=E.phaseAt(phase,ctx.n,to.r,to.c),domain=phase.domains[at.slot];
   return domain?.length&&domain.every(m=>{const cell=m.block.cells[at.i];return cell.type==='EMPTY'&&cell.attach==='EMPTY';});
  }))break;
  commands.push(d);prefixVisited.add(key);p=to;last=d;
 }
 return commands.length>=2?{confirmed:true,commands:commands.map(d=>'上下左右'[d]).join(''),target:p,proof:'visited-empty-corridor',savedInferenceRequests:commands.length-1}:null;
}
function apply(input,s){
 const t=s?.tactic;
 if(!s?.ok||!s.primary||!s.position?.unique||!KINDS.has(t?.kind)||t.batchRoute||t.batchCapture||t.batchEscape||s.primary.intentionalCollision||s.warnings?.some(w=>/矛盾|冲突/.test(w)))return s;
 const config=input.built?.views[input.built.self]?.model.config,rules=config?.roomRules||{};
 if(!config||config.brawl||config.deliberate||config.pointCapture===false||rules.点杀==='关闭'||rules.谋定后动==='开启'||(rules.隐匿||'关闭')!=='关闭'||config.event&&config.event!=='NONE')return s;
 if(Number(config.bombs)>0||Number(rules.炸弹)>0||config.boss?.length||(rules.BOSS&&rules.BOSS!=='无'))return s;
 let path=s.primary?.evaluation?.path;
 if(!path&&['escape','pursue'].includes(t.kind)){
  if(!t.destination&&!t.target)return s;
 }else if(!Array.isArray(path)||path.length<2)return s;
 const ctx=require('./objective-policy.cjs').context(input);
 if(!ctx||!ctx.certain||ctx.from.r!==s.position.r||ctx.from.c!==s.position.c||ctx.round!==t.round||t.steps!=null&&ctx.steps!==t.steps)return s;
 if(!path)path=require('./nov02-policy/pursuit.cjs').routeTo(ctx.from,t.kind==='escape'?t.destination:t.target,ctx)?.commands;
 if(!path||path[0]!==['up','down','left','right'].indexOf(s.primary.direction))return s;
 const batch=confirmedPrefix(ctx,path);if(!batch)return s;
 return {...s,primary:{...s.primary,reasons:['已走过的确定安静通路连续执行 '+batch.commands+'，到未知边或新格前再计算',...(s.primary.reasons||[]).filter(r=>!r.includes('先执行'))]},
  tactic:{...t,steps:ctx.steps,batchRoute:batch},knownPrefix:{steps:batch.commands.length,savedInferenceRequests:batch.savedInferenceRequests}};
}
module.exports={apply,confirmedPrefix};
