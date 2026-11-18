'use strict';
function retryPendingTurns(bot,state){
 for(const [groupId,turn] of bot.turns){
  const session='g'+groupId;
  if(turn.sent||state.group(groupId)?.ended||bot.inflight.has(session)||bot.timers.has(session))continue;
  turn.recovered=true;
  bot.scheduleInfer(session,{groupId,event:null},400);
 }
}
module.exports={retryPendingTurns};
