'use strict';
const K=require('./kernel.cjs'),{E}=K;
// Keep the original global conflict. Only replace our active frame with an
// independently verified reconstruction, excluding bearings and merged maps.
function localRecovery(input){
 if(input.recovery||!input.journal||!input.team?.conflict)return input;
 try{
  E.setDeadline(Date.now()+1500);
  const raw=K.build(input.journal),self=raw.self,view=raw.views[self];
  if(!view||raw.spectator||view.ambiguities.length||view.roundEnds.at(-1)?.inSpace)return input;
  const at=E.replay(view.model.segments[view.model.active],view.model.config.size),config=view.model.config;
  const solution=E.solveMap(config,at.observations,[]);
  const verification=E.certifyBlocks(config,solution,at.observations,2000);
  if(verification.status!=='verified'||solution.irregular||!solution.phases.length)return input;
  const id=self+':'+view.model.active,node={id,player:self,segment:view.model.active,solution,verification,observations:at.observations,mergedObservations:at.observations,anchors:[],joined:[{id,dr:0,dc:0}],focus:{r:at.r,c:at.c}};
  const built={...input.built,views:input.built.views.map((v,i)=>i===self?{...view,hears:[]}:v)};
  return {...input,built,team:{...input.team,nodes:input.team.nodes.filter(n=>n.id!==id).concat(node)},recovery:{kind:'independent-self',globalConflict:true,verification:'verified',frame:id}};
 }catch{return input;}finally{E.setDeadline();}
}
module.exports={localRecovery};
