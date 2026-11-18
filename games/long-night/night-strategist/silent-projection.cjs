'use strict';
const {E,M}=require('./kernel.cjs');
const Timeline=require('../vendor/long-night/timeline.js');
function publicRoutes(journal){
  // Keep the public move sequence independent from uncertain spatial segments.
  const routes = new Map(), routeRounds = new Map();
  for (const message of M.liveMessages(journal.messages)) for (const item of M.parse(message.text).items) {
    if(item.kind!=='trajectory')continue;
    const round=item.round ?? ((routeRounds.get(item.player)||0)+1);
    if(!item.partial)routeRounds.set(item.player,round);
    const key=`${item.player}:${round}`,old=routes.get(key);
    if(old&&!old.partial&&item.partial)continue;
    routes.set(key,{player:item.player,round,partial:!!item.partial,hidden:!!item.hidden,tokens:item.tokens});
  }
  return routes;
}


// A complete set of own-frame layouts can locate an endpoint without ever
// merging the opponent's uncertain intermediate frames.
function silentProjection({node,view,team,config,built,routes,deadline}){
 if(!config.silent||config.event!=='NONE'||built.count!==2||view.model.active!==0||
    view.ambiguities.length||view.localExit||team?.conflict||!node?.birth||node.routePending||
    node.fusionConflict||node.verification?.status!=='verified'||config.roomRules?.BOSS||
    config.roomRules?.教程==='开启'||Number(config.roomRules?.炸弹)>0||node.solution?.irregular)return null;
 const opponent=1-built.self;
 if(!built.players[opponent]?.alive||node.joined?.some(j=>j.id===opponent+':'+built.views[opponent].model.active))return null;
 const history=[...routes.values()];
 if(history.some(r=>r.hidden||r.tokens.some(t=>t.kind!=='move')))return null;
 const turns=history.filter(r=>r.player===opponent&&(!r.partial||r.tokens.length)).sort((a,b)=>a.round-b.round);
 if(!turns.length||turns.some((r,i)=>r.round!==i+1||i<turns.length-1&&r.partial))return null;
 const n=config.size,index=(r,c)=>E.mod(r,n)*n+E.mod(c,n);
 const starts=new Set(),ends=new Set(),countSets=new Map();
 E.setDeadline(Math.min(deadline??Infinity,Date.now()+3000));
 try{
  const maps=E.verifyCompleteLayout(config,node.solution,node.observations,180000,{limit:2400});
  if(!maps.complete||!maps.layouts?.length)return null;
  for(const layout of maps.layouts){
   E.checkDeadline();
   const cells=[],boxes=[],blockAt=[];
   for(const placement of layout){
    const block=E.byId.get(placement.id);
    block.cells.forEach((cell,i)=>{
     const k=index(placement.origin.r+Math.floor(i/3),placement.origin.c+i%3);
     cells[k]=cell;blockAt[k]=placement.id;
    });
   }
   const edges=cells.map((cell,k)=>E.V.map(([dr,dc],d)=>{
    const to=index(Math.floor(k/n)+dr,k%n+dc);
    return {to,kind:Math.max(cell.walls[d],cells[to].walls[E.OPP[d]])};
   }));
   // A box cannot occupy every square in its block: pushes stay inside the
   // block, cannot cross hedges, or land on buttons/coins/other attachments.
   // Ignore players and unknown door states here to keep a safe superset.
   for(let start=0;start<cells.length;start++)if(['BOX','HEATBOX','JAMMERBOX'].includes(cells[start].attach)){
    const queue=[start],seen=new Set(queue);boxes[start]=true;
    for(let head=0;head<queue.length;head++)for(const edge of edges[queue[head]]){
     if(![0,3,4].includes(edge.kind)||blockAt[edge.to]!==blockAt[start]||seen.has(edge.to)||!['EMPTY','COIN','BOX','HEATBOX','JAMMERBOX'].includes(cells[edge.to].attach))continue;
     seen.add(edge.to);boxes[edge.to]=true;queue.push(edge.to);
    }
   }
   const portals=cells.map((cell,k)=>{
    if(cell.type!=='PORTAL'||!cell.portal)return -1;
    const to=index(Math.floor(k/n)+cell.portal[0],k%n+cell.portal[1]);
    return [k,to].every(p=>edges[p].some(e=>e.kind===0||e.kind===2))?to:-1;
   });
   for(let birth=0;birth<n*n;birth++){
    if(birth===index(node.birth.r,node.birth.c))continue;
    let at=birth,transit=0,destination=-1,possible=true;const counts=new Map(),enemyObservations=[];
    for(const turn of turns){
     let last=-1,presses=0,ordinal=0;
     for(const step of turn.tokens){
      const d=step.dir,clock={player:opponent,round:turn.round,step:++ordinal},from=at,wasTransit=transit;
      if(!Number.isInteger(d)||!['move','hit'].includes(step.outcome))return null;
      if(transit){
       if(step.outcome==='hit'){possible=false;break;}
       if(--transit===0){at=destination;if(cells[at].attach==='BUTTON')presses++;}
      }else{
       const {kind,to}=edges[at][d];
       // An observed hit may be a box or a switched door. Keep both
       // explanations instead of assigning a probability to the wall type.
       if(step.outcome==='hit'){
        if(kind===0&&!boxes[to]||kind===2&&last===d&&!boxes[to])possible=false;
        enemyObservations.push({kind:'hit',r:Math.floor(at/n),c:at%n,dir:d,last,clock},{kind:'action',r:Math.floor(at/n),c:at%n,arrival:false,clock});
        break;
       }
       if(kind===1||kind===2&&last!==d||cells[to].type==='EXIT'){possible=false;break;}
       at=to;if(cells[to].attach==='BUTTON')presses++;
       if(portals[to]>=0){transit=2;destination=portals[to];}
      }
      if(!wasTransit)enemyObservations.push({kind:'pass',r:Math.floor(from/n),c:from%n,dir:d,last,clock});
      enemyObservations.push({kind:'action',r:Math.floor(at/n),c:at%n,arrival:!wasTransit||transit===0,clock});
      last=d;
     }
     if(!possible)break;
     if(!turn.partial){counts.set(turn.round,presses);enemyObservations.push({kind:'turnEnd',r:Math.floor(at/n),c:at%n,clock:{player:opponent,round:turn.round,step:1000000}});}
    }
    if(!possible)continue;
    // Reject only when both complete turn histories establish the public sum.
    // BoxMove rejects every non-empty attachment, including BUTTON, and cannot
    // move the button itself. Possible box collisions widen route support but
    // do not change button counts along a fixed successful move sequence.
    for(const [round,enemyCount] of counts){
      const obs=node.walkingObservations||node.observations||[];
      const own=obs.filter(o=>o.clock?.player===built.self&&o.clock?.round===round);
      const actions=new Map(own.filter(o=>o.kind==='action').map(o=>[o.clock.step,o]));
      const complete=own.some(o=>o.kind==='turnEnd')&&Array.from({length:Math.max(0,...actions.keys())},(_,i)=>i+1).every(k=>actions.has(k));
      if(!complete)continue;
      const ownCount=[...actions.values()].filter(o=>o.arrival&&cells[index(o.r,o.c)]?.attach==='BUTTON').length;
      if(config.buttonCounts?.[round]!=null&&ownCount+enemyCount!==config.buttonCounts[round]){possible=false;break;}
    }
    if(!possible)continue;
    // Door choices are coupled to the buttons on these very routes. Treating
    // each door independently could invent a press followed by an impossible
    // collision against the door that the press had just opened.
    if(!Timeline.check(config,layout.map(m=>({...m,block:E.byId.get(m.id)})),(node.walkingObservations||node.observations).concat(enemyObservations)).valid)continue;
    const spawn=E.birthLayoutCheck(config,layout,[{...node.birth,player:built.self},{r:Math.floor(birth/n),c:birth%n,player:opponent}]);
    if(!spawn.valid&&!spawn.pending)continue;
    if(transit)return null;
    starts.add(birth);ends.add(at);
    for(const [round,count] of counts){if(!countSets.has(round))countSets.set(round,new Set());countSets.get(round).add(count);}

   }
  }
 }catch(e){if(e.code==='INFERENCE_TIMEOUT')return null;throw e;}finally{E.setDeadline();}
 if(!ends.size)return null;
 const point=k=>({r:Math.floor(k/n),c:k%n});
 return {player:opponent,round:turns.at(-1).round,partial:!!turns.at(-1).partial,positions:[...ends].map(point),birth:starts.size===1?point([...starts][0]):null,playerButtonCounts:[...countSets].filter(([r,s])=>s.size===1).map(([round,s])=>({player:opponent,round,count:[...s][0],source:'exhaustive-silent-layouts'}))};
}
function currentPositions(projection,built,ownRound){
 if(!projection||projection.partial||!built.players[projection.player]?.alive)return null;
 const expected=projection.player<built.self?ownRound:ownRound-1;
 const last=built.views[projection.player].roundEnds.at(-1);
 if(projection.round!==expected||last?.round!==expected||!last.complete||last.inSpace)return null;
 return {target:projection.player,round:expected,positions:projection.positions,source:'silent-layouts',
   exhaustive:true,frame:built.self+':0'};
}
function matchesReport(report){
 const tactic=report?.suggestion?.tactic,proof=report?.board?.opponentProjection;
 const target=tactic?.target;
 if(!proof||proof.partial||!target||proof.player!==target.target||proof.round!==target.round||
   proof.round!==(proof.player<report.self?tactic.round:tactic.round-1))return false;
 return proof.positions.length===1&&proof.positions[0].r===target.r&&proof.positions[0].c===target.c;
}
module.exports={silentProjection,publicRoutes,currentPositions,matchesReport};
