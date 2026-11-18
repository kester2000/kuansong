'use strict';
const {compatibleAssignments,exactDecision}=require('./exact-decision.cjs');
const {exactBirth,multiply}=require('./exact-birth.cjs');
const {buildWorld}=require('./bayes-worlds.cjs');

// Exact conditional decision for a specified game model. phasePrior and
// placementPrior must describe the generator *before* conditioning on clues.
// histories must produce all compatible histories with their conditional mass.
function solvePrunedDecision({phases,n,exitCount,observations,dynamicDoors,
 seats,births,phasePrior,placementPrior,histories,commands,evaluate,initialBoard=buildWorld}){
 function* posterior(){
  for(const phase of phases){
   for(const selected of compatibleAssignments({phase,n,exitCount,observations,dynamicDoors})){
    const prior=multiply(phasePrior(phase),placementPrior(selected));
    if(!prior[0])continue;
    const world=initialBoard(phase,selected,n);
    const start=multiply(prior,exactBirth(world,births,seats));
    if(!start[0])continue;
    for(const branch of histories(world)){
     const weight=multiply(start,branch.likelihood);
     if(weight[0])yield {state:branch.state,weight};
    }
   }
  }
 }
 return exactDecision(posterior(),commands,evaluate);
}
module.exports={solvePrunedDecision};
