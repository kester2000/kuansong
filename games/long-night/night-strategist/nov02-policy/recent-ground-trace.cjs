'use strict';
const {E,M}=require('./kernel.cjs');

// Relative visit memory only. It does not add terrain, walls, anchors or an
// alignment to the inference model. Even an unresolved earlier teleport has
// finished two commands after its latest possible entrance.
function groundTrace(moves,config,from){
 const rules=config.roomRules||{};
 if(config.silent||config.dark||config.portalChaos||config.brawl||config.event&&config.event!=='NONE'
  ||rules.静音==='开启'||rules.隐匿&&rules.隐匿!=='关闭'||Number(rules.炸弹)>0
  ||rules.BOSS&&rules.BOSS!=='无'||moves.some(t=>t.outcome!=='move'||t.hidden))return null;
 let anchorStep=0;
 for(let i=0;i<moves.length;i++){
  const t=moves[i],step=i+1;
  // Assume a heart could be present even if its presence is still unknown.
  // An unreported entrance at a beat can relocate on either following command.
  const mayEnter=t.sound==='PAPA'||['PORTAL','ONEWAYPORTAL'].includes(t.terrain)
   ||t.masked||step<=19&&(step-1)%3===0;
  if(mayEnter)anchorStep=step+2;
 }
 if(moves.length-anchorStep<4)return null;
 const trace=[{r:0,c:0}],n=config.size;
 for(const t of moves.slice(anchorStep)){
  if(!Number.isInteger(t.dir)||t.dir<0||t.dir>3)return null;
  const p=trace.at(-1);trace.push({r:E.mod(p.r+E.V[t.dir][0],n),c:E.mod(p.c+E.V[t.dir][1],n)});
 }
 const end=trace.at(-1);
 return {anchorStep,steps:moves.length,trace:trace.map(p=>({r:E.mod(p.r+from.r-end.r,n),c:E.mod(p.c+from.c-end.c,n)})),
  proof:'relative movement after every possible portal transit; no terrain or global position claim'};
}
function recentGroundTrace(input,round,from){
 const self=input.built?.self,view=input.built?.views?.[self];
 if(!view?.ambiguities.length||view.localExit||input.team?.conflict)return null;
 let route;
 for(const m of M.liveMessages(input.journal?.messages||[]))for(const t of M.parse(m.text).items)
  if(t.kind==='trajectory'&&t.player===self&&t.round===round)route=t;
 if(!route?.partial||route.tokens.some(t=>t.kind!=='move'))return null;
 return groundTrace(route.tokens,view.model.config,from);
}
module.exports={groundTrace,recentGroundTrace};
