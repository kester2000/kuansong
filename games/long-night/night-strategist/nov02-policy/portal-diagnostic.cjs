'use strict';
const K=require('./kernel.cjs'),{E}=K;
const {turnFacts}=require('./local-exit.cjs');
const {edgeState}=require('./movement.cjs');
// Score a short experiment in BOTH worlds: ground versus portal transit.
// Conditional ground coordinates are never promoted to confirmed positions.
function portalDiagnostic(input){
 const {built,journal}=input,self=built.self,v=built.views[self];
 if(!journal||v.model?.config?.portalChaos||v.localExit||input.team?.conflict||v.ambiguities.length!==1)return null;
 const a=v.ambiguities[0],facts=turnFacts(journal,self,a.round),elapsed=facts.steps-a.step;
 const maskedEntry=a.maskedUnknown||journal.messages.some(m=>m.text.includes(`第 ${a.round} 回合`)&&m.text.includes(`第 ${a.step} 步`)&&m.text.includes('啪嗒')&&m.text.includes('心跳声掩盖'));
 if(a.silentUnknown||a.recoveryUnknown||v.model.config.silent||elapsed<0||elapsed>1)return null;
 if(facts.moves.slice(a.step).some(t=>t.outcome!=='move'||t.sound||t.terrain))return null;
 const remaining=2-elapsed,exitStep=facts.steps+remaining;
 // Heartbeat masking still produces our own private terrain-sound clue.
 try{
  const budget=Math.max(1,Math.min(1200,input.decisionBudgetMs??1200));
  E.setDeadline(Date.now()+budget);
  const choices=E.clone(built.resolvedChoices||{});choices[self]={...(choices[self]||{}),[a.key]:{kind:'ground'}};
  const ground=K.build(journal,choices),view=ground.views[self];
  if(view.ambiguities.length||view.model.active!==a.segment)return null;
  const n=view.model.config.size,at=E.replay(view.model.segments[view.model.active],n);
  const solution=E.solveMap(view.model.config,at.observations,[]);
  const verified=E.certifyBlocks(view.model.config,solution,at.observations,budget);
  if(verified.status!=='verified')return null;
  const ctx={n,wallKinds:require('./edge-kinds.cjs').edgeKinds(view.model.config,solution),walls:E.inferredWalls(view.model.config,solution),terrain:E.terrainPossibilities(solution,n)};
  const plans=[];
  function walk(p,path){
   if(path.length===remaining){
    let exits=0;for(let d=0;d<4;d++)if(edgeState(p,d,ctx).wall==='空'&&!edgeState(p,d,ctx).blocked)exits++;
    // 100: contrasting exit PAPA vs ground silence; 40: both commands
    // preserve this turn; endpoint mobility breaks ties, never map frequency.
    const straight=path.length>1&&path.every(d=>d===path[0])?3:0;
    plans.push({commands:path,score:140+exits+straight,components:{branchSeparation:100,continueTurn:40,mobility:exits,straight}});return;
   }
   for(let d=0;d<4;d++){
    const edge=edgeState(p,d,ctx,path.at(-1)??at.last);
    if(edge.blocked||edge.uncertain||edge.wall!=='空'||edge.kinds.some(k=>k!==0))continue;
    const to={r:E.mod(p.r+E.V[d][0],n),c:E.mod(p.c+E.V[d][1],n)},types=ctx.terrain.get(E.key(to.r,to.c))||[];
    if(types.length!==1||types[0]!=='EMPTY')continue;
    if(path.length&&d===[1,0,3,2][path.at(-1)])continue;
    walk(to,[...path,d]);
   }
  }
  walk(at,[]);plans.sort((a,b)=>b.score-a.score||a.commands.join('').localeCompare(b.commands.join('')));
  return plans.length?{...plans[0],alternatives:plans,round:a.round,entryStep:a.step,remaining,exitStep,conditional:true}:null;
 }catch{return null;}finally{E.setDeadline();}
}
module.exports={portalDiagnostic};
