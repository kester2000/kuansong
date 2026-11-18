'use strict';
const distance=(a,b,n)=>{const r=Math.abs(a.r-b.r),c=Math.abs(a.c-b.c);return Math.min(r,n-r)+Math.min(c,n-c);};
function openingEvaluation(to,from,ctx,fresh){
 const {candidates,exits}=ctx.openingObjective;
 const nearest=(p,points)=>Math.min(...points.map(q=>distance(p,q,ctx.n)));
 const d=nearest(to,candidates.positions),proximity=12/(d+1)+(d===0?12:0);
 const exitProgress=fresh&&exits.length?Math.max(-1,Math.min(1,nearest(from,exits)-nearest(to,exits)))*3:0;
 return {nearestOpponent:d,proximity,exitCandidates:exits.length,exitProgress};
}
function rankOpening(moves,from,ctx,candidates,seekExit=true){
 if(!candidates?.exhaustive||!candidates.positions.length)return;
 // All domain possibilities, never frequency in capped map samples.
 const exits=[...ctx.terrain].filter(([,types])=>types.includes('EXIT')).map(([k])=>{const [r,c]=k.split(',').map(Number);return {r,c};});
 const boundedExits=seekExit&&exits.length>0&&exits.length<=12?exits:[];
 ctx.openingObjective={candidates,exits:boundedExits};
 for(const m of moves){
  if(m.blocked||m.explorationForbidden)continue;
  const evaluation=openingEvaluation(m.to,from,ctx,m.evaluation?.information>0);
  const {nearestOpponent:d,proximity,exitProgress}=evaluation;
  m.score+=exitProgress-proximity;
  m.evaluation.openingObjective=evaluation;
  m.reasons.push(`首轮目标受保护：避开对手兼容位置，最近距离 ${d}；探索用于寻找逃生通路`);
  if(boundedExits.length)m.reasons.push(`逃生舱仍有 ${boundedExits.length} 个地形兼容候选，仅作探路方向，不代表已确认出口或概率`);
 }
}
module.exports={rankOpening,openingEvaluation};
