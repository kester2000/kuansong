'use strict';
const crypto=require('node:crypto');
function seedFor(journal){
 return journal?.meta?.openingSeed||journal?.meta?.createdAt||
  journal?.messages?.find(m=>m.source?.key)?.source.key||'legacy-replay';
}
// Stable within the same game/turn/step; private per-game seed varies games.
function chooseOpening(moves,{journal,self,round,steps,score=m=>m.score}={}){
 const best=moves[0];if(!best||round!==1||steps>=4)return best;
 const risk=m=>m.evaluation||{};
 const candidates=moves.filter(m=>!m.blocked&&!m.explorationForbidden&&Number.isFinite(score(m))&&score(m)>=score(best)-1.5
  &&(m.failedProbeCount||0)<=(best.failedProbeCount||0)
  &&['physical','exposure','collision'].every(k=>(risk(m)[k]||0)<=(risk(best)[k]||0))
  &&(risk(best).information<=0||!(risk(m).information<=0)));
 if(candidates.length<2)return best;
 const value=m=>crypto.createHash('sha256').update(JSON.stringify([seedFor(journal),self,round,steps,m.dirIndex])).digest().readUInt32BE(0);
 const selected=candidates.slice().sort((a,b)=>value(a)-value(b))[0];
 selected.reasons.push(`开局随机择路：候选 ${candidates.map(m=>m.arrow||m.label||m.direction).join('、')}，选择 ${selected.arrow||selected.label||selected.direction}；同风险、近似收益，同一步重算保持一致`);
 selected.openingChoice={directions:candidates.map(m=>m.direction),selected:selected.direction};
 return selected;
}
module.exports={chooseOpening,seedFor};
