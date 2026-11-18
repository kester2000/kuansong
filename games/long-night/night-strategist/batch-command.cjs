'use strict';
// Shared by the live sender and the isolated arena. A route proof still has
// to match the live turn, target and first direction before dispatch.
function batchCommand(report,first,round,steps){
 const tactic=report?.suggestion?.tactic,escape=tactic?.kind==='escape';
 const routeBatch=['objective-explore','verify-exit','escape','pursue','deliberate-batch','solo-prefix','bounded-exploration','quiet-exploration-before-candidates'].includes(tactic?.kind)&&tactic.steps===steps?tactic.batchRoute:null;
 const batch=routeBatch||(escape?tactic.batchEscape:tactic?.batchCapture);
 const goal=routeBatch?routeBatch.target:escape?tactic.destination:tactic?.target;
 const eligible=!!routeBatch||escape||(tactic?.kind==='pursue'&&tactic.round>1&&(['same-cell-sound','aligned-map'].includes(goal?.source)
   ||goal?.source==='silent-layouts'&&require('./silent-projection.cjs').matchesReport(report)));
 return eligible&&tactic.round===round&&batch?.confirmed===true
   &&goal&&batch.target?.r===goal.r&&batch.target?.c===goal.c
   &&/^[上下左右]{2,}$/.test(batch.commands)&&batch.commands[0]===first?batch.commands:first;
}
module.exports={batchCommand};
