'use strict';
const {fraction,add,multiply,divide}=require('./exact-birth.cjs');
const ZERO=[0n,1n],ONE=[1n,1n];
function falling(n,k){let result=1n;for(let i=0;i<k;i++){if(n-i<=0)return 0n;result*=BigInt(n-i);}return result;}

// Prior before any spawn or trajectory observations. An ordered local pattern
// marginalizes every unmentioned slot analytically; no full-map enumeration.
// Source: UnitMaps::RandomSelectBlocks (choose normals/exits, then shuffle).
function blockAssignmentPrior({pool,slots,exitCount,assignments,custom=false}){
 if(!Number.isInteger(slots)||slots<1||!Number.isInteger(exitCount)||exitCount<0||exitCount>slots)throw Error('Invalid map quota');
 const ids=new Map(pool.map(b=>[String(b.id),b]));
 if(ids.size!==pool.length)throw Error('Duplicate pool IDs');
 const fixed=new Map();
 for(const {slot,id:rawId} of assignments){
  const id=String(rawId);
  if(!Number.isInteger(slot)||slot<0||slot>=slots||!ids.has(id))throw Error('Invalid local assignment');
  if(fixed.has(slot)&&fixed.get(slot)!==id)return ZERO;
  fixed.set(slot,id);
 }
 if(new Set(fixed.values()).size!==fixed.size)return ZERO;
 const exits=pool.filter(b=>String(b.id).startsWith('E')),normal=pool.filter(b=>!String(b.id).startsWith('E'));
 const q=custom?Math.min(exitCount,exits.length):exitCount,k=slots-q;
 if(exits.length<q||normal.length<k)throw Error('Unfilled map slots are not a regular tiling');
 const isHeat=b=>b.cells.some(c=>c.type==='HEAT'),isHeatBox=b=>b.cells.some(c=>c.attach==='HEATBOX');
 const heat=normal.filter(isHeat),boxes=normal.filter(b=>!isHeat(b)&&isHeatBox(b)),other=normal.filter(b=>!isHeat(b)&&!isHeatBox(b));
 const conflict=normal.some(isHeat)&&normal.some(isHeatBox);
 const exclusive=conflict&&(!custom||other.length+Math.min(heat.length,boxes.length)>=k);
 const branches=!exclusive?[{normal,weight:ONE}]:!boxes.length?[{normal:[...other,...heat],weight:ONE}]:!heat.length?[{normal:[...other,...boxes],weight:ONE}]:[{normal:[...other,...heat],weight:fraction(1n,2n)},{normal:[...other,...boxes],weight:fraction(1n,2n)}];
 const fixedIds=[...fixed.values()],e=fixedIds.filter(id=>id.startsWith('E')).length,a=fixed.size-e;
 if(e>q||a>k)return ZERO;
 let prior=ZERO;
 for(const branch of branches){
  if(branch.normal.length<k)throw Error('Heat-exclusive draw leaves gaps; irregular-map model required');
  const allowed=new Set([...branch.normal,...exits].map(b=>String(b.id)));
  if(fixedIds.some(id=>!allowed.has(id)))continue;
  // P(exit/normal category at each queried slot) times the probability of
  // these distinct IDs within each category. Falling factorials include
  // without-replacement dependence and the exact exit quota.
  const num=falling(q,e)*falling(k,a),den=falling(slots,fixed.size)*falling(exits.length,e)*falling(branch.normal.length,a);
  prior=add(prior,multiply(branch.weight,fraction(num,den)));
 }
 return prior;
}

// A conditional extension shares overlapping slots with its parent. It is
// P(parent U extra) / P(parent), never a product of overlapping marginals.
function extensionPrior(model,parent,extra){
 const before=blockAssignmentPrior({...model,assignments:parent});
 if(!before[0])throw Error('Cannot extend a zero-mass hypothesis');
 return divide(blockAssignmentPrior({...model,assignments:[...parent,...extra]}),before);
}

// Local hypotheses must be a disjoint, exhaustive partition of one model.
// Birth likelihood is an explicit factor, not silently replaced with 1 or
// a uniform cell distribution. The full source prior is globally coupled.
function localPosterior(hypotheses,{complete=false}={}){
 if(!complete)throw Error('Cannot normalize an unfinished local partition');
 const weighted=hypotheses.map(h=>{
  if(!h.prior||!h.feedbackLikelihood||!h.birthLikelihood)throw Error('Missing prior, feedback likelihood or birth likelihood');
  return {...h,mass:multiply(multiply(h.prior,h.feedbackLikelihood),h.birthLikelihood)};
 });
 const evidence=weighted.reduce((sum,h)=>add(sum,h.mass),ZERO);
 if(!evidence[0])throw Error('No compatible local hypothesis');
 return {evidence,hypotheses:weighted.map(h=>({...h,posterior:divide(h.mass,evidence)}))};
}
module.exports={blockAssignmentPrior,extensionPrior,localPosterior,falling};
