'use strict';
// A solver view (including its default seat 0) is not participation evidence.
function matchKey(group){
 if(!group?.session||!group.startedAt||group.openingMessageId==null)return null;
 return [group.session,String(group.openingMessageId),group.startedAt].join('|');
}
function proofForPrompt(group,selfId,event,turn,mentionedIds){
 const key=matchKey(group),time=Number(event?.time)*1000,start=Date.parse(group?.startedAt);
 if(!key||group.ended||!selfId||String(event?.user_id)!==String(group.gameBotId)||event?.message_id==null
   ||!Number.isFinite(time)||time<start||!Number.isInteger(turn?.player)||turn.player<0||turn.player>7
   ||!['start','continue'].includes(turn.kind)||mentionedIds.length!==1||String(mentionedIds[0])!==String(selfId))return null;
 return {status:'confirmed',kind:'judge-turn',matchKey:key,selfId:String(selfId),player:turn.player,messageId:String(event.message_id),time:event.time};
}
function valid(proof,key,selfId){return !!key&&proof?.status==='confirmed'&&proof.kind==='judge-turn'&&proof.matchKey===key
 &&proof.selfId===String(selfId)&&Number.isInteger(proof.player)&&proof.player>=0&&proof.player<=7&&proof.messageId!=null;}
function participated(group,selfId){return valid(group?.participation,matchKey(group),selfId);}
function recordParticipated(record,selfId){const s=record?.board?.settings;return valid(s?.participation,s?.matchKey,selfId)&&s.matchKey.startsWith(record.session+'|');}
module.exports={matchKey,proofForPrompt,participated,recordParticipated};
