'use strict';
const K=require('./kernel.cjs'),{E}=K;
const GROUND=new Set(['EMPTY','WATER','GRASS','BERRY','TRAP','HEAT','HEART','EXIT']);
function proofBudget(requested,remaining){
 return Math.min(Number(requested)||1000,1000,Math.max(1,Math.floor(remaining/3)));
}
// Use all still-compatible domains, never a witnessed/sample layout. This
// proves only that the entry is ground; it does not certify a route or target.
function supported(config){return config?.mode==='TWIST'&&!config.silent&&!config.portalChaos&&!config.brawl&&!config.dark&&!config.deliberate&&!config.heartConflict
 &&(!config.event||config.event==='NONE')&&!config.boss?.length&&!(Number(config.bombs)>0);}
function groundDomains(solution,entry,config){
 const n=config.size;
 if(!solution||solution.irregular||!solution.phases?.length||!Number.isInteger(entry?.r)||!Number.isInteger(entry?.c))return false;
 for(const phase of solution.phases){
  const at=E.phaseAt(phase,n,entry.r,entry.c),domain=phase.domains?.[at.slot];
  if(!domain?.length)return false;
  for(const candidate of domain){const cell=(candidate.block||E.byId.get(candidate.id))?.cells[at.i];if(!GROUND.has(cell?.type))return false;}
 }
 return true;
}
function provenGroundEntry({view,node,team,ambiguity,config}){
 if(!supported(config)||!view||view.model.active!==ambiguity?.segment||view.ambiguities.length||team?.conflict
  ||node?.verification?.status!=='verified'||node.fusionConflict||node.routePending)return false;
 return groundDomains(node.solution,ambiguity.entry,config);
}
function historicalGroundProof(prefix,self,ambiguity,deadline){
 // The old frame has no uncertain route, so solve/certify its own received
 // observations directly. Re-running other players cannot strengthen this
 // independent local certificate and used up the optional proof slice.
 try{
  E.setDeadline(deadline);const built=K.build(prefix),view=built.views[self],config=view?.model.config;
  if(built.self!==self||!supported(config)||view.model.active!==ambiguity.segment||view.ambiguities.length)return null;
  const node=K.L.nodes(built).find(n=>n.player===self&&n.segment===ambiguity.segment);if(!node)return null;
  const solution=E.solveMap(config,node.observations,node.anchors);
  if(!groundDomains(solution,ambiguity.entry,config))return null;
  const verification=E.certifyBlocks(config,solution,node.observations);
  if(provenGroundEntry({view,node:{...node,solution,verification},team:{conflict:false},ambiguity,config}))return {choices:built.resolvedChoices||{},ground:true};
 }catch(error){if(error.code!=='INFERENCE_TIMEOUT')throw error;}finally{E.setDeadline();}
 return null;
}
module.exports={proofBudget,provenGroundEntry,historicalGroundProof};
