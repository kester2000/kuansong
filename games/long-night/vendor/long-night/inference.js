(function longNightModule(root){
 'use strict';
  (root.LongNightSources ||= {})['inference.js']=longNightModule.toString();
 const get=(file,name)=>typeof module!=='undefined'?require('./'+file):root[name];
 const E=get('engine','LongNight'),M=get('messages','LongNightMessages'),L=get('local','LongNightLocal'),H=get('hypotheses','LongNightHypotheses'),T=get('team','LongNightTeam'),S=get('sound-candidates','LongNightSoundCandidates'),R=get('route-explanations','LongNightRouteExplanations');
 async function run(request,emit=()=>{},cancelled=()=>false){
  const budget=Math.min(request.playerBudgetMs??15000,15000),statuses=[],nodes=[],hypotheses=[];
  const startedAt=Date.now(),totalBudget=request.totalBudgetMs??budget*(request.notebook.count+1),deadline=startedAt+Math.max(1,totalBudget);
  let notebook=request.notebook;
  const playerConfig={...request.config,witnessFirst:true,independentPerspective:true};
  const deductions=request.deductions;
  if(deductions){notebook=get('inference-facts','LongNightFacts').apply(notebook,deductions);request={...request,config:M.build(notebook.base,notebook.messages,notebook.choices).model.config};Object.assign(playerConfig,request.config);}
  let choices={...(notebook.choices||{})},relations=request.relations,result,choicesRolledBack=false;
  // Silent movement cannot establish a walking trajectory when route search
  // is interrupted. Checkpoint uncertain frames without changing the normal
  // hypothesis search or discarding choices that it has already proved.
  const pendingChoices=player=>request.config.silent?{...choices,[player]:{...(choices[player]||{}),__portalRecovery:true}}:choices;
  const order=[notebook.self,...Array.from({length:notebook.count},(_,i)=>i).filter(i=>i!==notebook.self)];
  for(const player of order){
   await new Promise(resolve=>setTimeout(resolve,0));if(cancelled())return null;
   if(Date.now()>=deadline){choices=pendingChoices(player);statuses.push({player,status:'budget-skipped',elapsedMs:0});continue;}
   const start=Date.now();E.setDeadline(Math.min(start+(player===notebook.self?(request.selfBudgetMs??budget):budget),deadline));emit({progress:{stage:'player-budget',player}});
   let checkpoint=[],checkpointChoices={...(choices[player]||{})},checkpointHypothesis=null;
   try{
    let built,own,h,resolved;
    // Keep a cheap local domain checkpoint before costly trajectory branches.
    // Exhausting a global proof budget must not erase the acting player's map.
    if(player===notebook.self){
     const initialChoices=pendingChoices(player),initial=M.build(notebook.base,notebook.messages,initialChoices);
     checkpointChoices={...(initialChoices[player]||{})};
     for(const node of L.nodes(initial).filter(n=>n.player===player)){
      const solution=E.solveMap(request.config,node.observations,node.anchors);
      checkpoint.push({...node,solution,verification:{status:'unknown',blocks:[]},local:{waiting:true,pending:true,singles:[],doubles:[],triples:[],expanded:[],focusCandidates:[]}});
     }
    }
    for(;;){
     E.checkDeadline();
     h=H.analyze({...playerConfig,onRouteStart:({model,first,choices:routeChoices})=>{
      // The acting player already has all local frames checkpointed above.
      // Replacing them with the first ambiguous entrance drops later known
      // walls and can turn a safe portal departure into a fallback guess.
      if(player===notebook.self)return;
      // Publish the certain entrance prefix before branching. If the search
      // times out, the source player still exists for sound-region analysis;
      // its unknown continuation is never relabelled as a walking endpoint.
      const segment=model.segments[first.segment],at=E.replay(segment,request.config.size);
      const observations=at.observations.filter(o=>!o.clock||o.clock.round<first.round||o.clock.round===first.round&&o.clock.step<=first.step);
      const solution=E.solveMap(request.config,observations,segment.anchors||[]);
      const mid=Math.floor(request.config.size/2),node={id:player+':'+first.segment,player,segment:first.segment,observations,anchors:segment.anchors||[],focus:{...first.entry},birth:first.segment===0?{r:mid,c:mid}:null,routePending:true,
       solution,verification:{status:'unknown',blocks:[]},local:{waiting:true,pending:true,singles:[],doubles:[],triples:[],expanded:[],focusCandidates:[]},
       soundAlternatives:[{observations,solution,pending:true,positions:[]}]};
      checkpoint=[node];checkpointChoices={...(routeChoices||{})};checkpointHypothesis=null;
     }},notebook.base,notebook.messages,player,notebook.self,null,choices[player]||{});
     const updated=H.choiceUpdates(h?[h]:[],choices);if(!updated)break;if(h?.resolvedChoices&&h.portalExamples?.length)resolved=h;choices=updated;
    }
    built=M.build(notebook.base,notebook.messages,choices);relations=built.relations.filter(r=>!['首次','被屏蔽'].includes(r.direction));
    own=L.nodes(built).filter(n=>n.player===player);
    if(!own.some(n=>n.observations.length||n.anchors?.length)){statuses.push({player,status:'waiting',elapsedMs:Date.now()-start});continue;}
    if(!h&&resolved)h=resolved;
    if(h)hypotheses.push(h);
    const constrained=H.constrainNodes(own,relations,h?[h]:[]);
    if(deductions){checkpoint=constrained.nodes.map(node=>{const solution=E.solveMap(request.config,node.observations,node.anchors);return {...node,solution,verification:E.certifyBlocks(request.config,solution,node.observations,3000),local:{waiting:true,pending:true,singles:[],doubles:[],triples:[],expanded:[],focusCandidates:[]}};});checkpointChoices={...(choices[player]||{})};checkpointHypothesis=h;
    emit({partial:true,team:{nodes:[...nodes,...checkpoint],pairs:[],conflict:false,combined:null,hypotheses,soundCandidates:[],completedChoices:choices}});}
    const local=(request.solveLocal||T.solve)(request.config,constrained.nodes,constrained.relations,partial=>{checkpoint=partial.nodes;checkpointChoices={...(choices[player]||{})};checkpointHypothesis=h;},p=>emit({progress:p}));
    checkpoint=local.nodes;checkpointChoices={...(choices[player]||{})};checkpointHypothesis=h;
    for(const node of local.nodes){if(node.routePending)node.walkingDisplaySolution=T.walkingSolution(request.config,node);node.routeExplanation=R.forNode(request.config,node);}
    E.checkDeadline();nodes.push(...local.nodes);
    statuses.push({player,status:'complete',elapsedMs:Date.now()-start});
   }catch(error){if(error.code!=='INFERENCE_TIMEOUT')throw error;
    // A new route may merge/reindex frames before its local map is ready.
    // Publish the choices belonging to the retained map, never a mixture.
    if(JSON.stringify(choices[player]||{})!==JSON.stringify(checkpointChoices))choicesRolledBack=true;
    choices={...choices,[player]:checkpointChoices};
    for(let i=hypotheses.length-1;i>=0;i--)if(hypotheses[i].player===player)hypotheses.splice(i,1);
    if(checkpointHypothesis)hypotheses.push(checkpointHypothesis);
    nodes.push(...checkpoint);statuses.push({player,status:'timeout',elapsedMs:Date.now()-start});}
   finally{E.setDeadline();}
   emit({playerStatus:statuses.at(-1)});
   emit({partial:true,team:{nodes,pairs:[],conflict:false,combined:null,hypotheses,soundCandidates:[],playerStatuses:statuses,completedChoices:choices}});
  }
  if(request.config.silent||choicesRolledBack)relations=M.build(notebook.base,notebook.messages,choices).relations.filter(r=>!['首次','被屏蔽'].includes(r.direction));
  result={nodes,pairs:[],conflict:false,combined:null,hypotheses,soundCandidates:[]};
  // Joint alignment has its own bound; failing it must not erase completed views.
  let jointStatus='skipped';
  if(nodes.length>1&&Date.now()<deadline){
   await new Promise(resolve=>setTimeout(resolve,0));if(cancelled())return null;
   E.setDeadline(Math.min(Date.now()+(request.jointBudgetMs??totalBudget),deadline));emit({progress:{stage:'joint-budget'}});
   let alignedCheckpoint=null;
   try{
    const pending=new Set(nodes.filter(n=>n.routePending&&!hypotheses.some(h=>n.id===h.player+':'+h.segment)).map(n=>n.id));
    const constrained=H.constrainNodes(nodes,relations.filter(r=>!pending.has(r.aNode)&&!pending.has(r.bNode)),hypotheses),joint=T.solve(request.config,constrained.nodes,constrained.relations,partial=>{if(partial.stage==='aligned')alignedCheckpoint=partial;},p=>emit({progress:p}),nodes);
    joint.hypotheses=hypotheses;joint.soundCandidates=S.analyze(request.config,S.attach(joint.nodes,hypotheses),request.soundRelations||relations,p=>emit({progress:p}));
    for(const node of joint.nodes){if(node.routePending)node.walkingDisplaySolution=T.walkingSolution(request.config,node);node.routeExplanation=R.forNode(request.config,node);}
    E.checkDeadline();result=joint;jointStatus='complete';
   }catch(error){if(error.code!=='INFERENCE_TIMEOUT')throw error;if(alignedCheckpoint)result={...alignedCheckpoint,hypotheses,soundCandidates:[]};jointStatus='timeout';}
   finally{E.setDeadline();}
  }
  const output={...result,playerStatuses:statuses,jointStatus,completedChoices:choices,timing:{elapsedMs:Date.now()-startedAt,totalBudgetMs:totalBudget}};
  return output;
 }
 const api={run};if(typeof module!=='undefined')module.exports=api;else root.LongNightInference=api;
})(globalThis);
