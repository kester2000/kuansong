'use strict';
// Port of lgtbot bot_core/score_calculation.cc CalLevelScore.
// Same players => expected score and multiplier cancel when comparing routes.
function rank(scores,self){
 const score=scores[self];
 return (2*scores.filter(s=>s<score).length+scores.filter(s=>s===score).length)/scores.length-1;
}
function calculate(scores,self,matchCount,levels){
 if(!scores.length||!scores.every(Number.isFinite)||!Number.isInteger(self)||self<0||self>=scores.length
   ||!Number.isInteger(matchCount)||matchCount<0||levels?.length!==scores.length||!levels.every(Number.isFinite))throw new Error('Incomplete rating inputs');
 const average=levels.reduce((a,b)=>a+b,0)/levels.length;
 const multiplier=matchCount>400?20:100-0.2*matchCount;
 const expected=1/(1+2**((average-levels[self])/200))-0.5;
 return {actual:rank(scores,self),expected,multiplier,delta:multiplier*(rank(scores,self)-expected)};
}
function rankRange(scores,self){
 const lower=scores.map((s,i)=>s[i===self?0:1]),upper=scores.map((s,i)=>s[i===self?1:0]);
 return [rank(lower,self),rank(upper,self)];
}
function compare(escape,capture,self){
 const e=rankRange(escape,self),c=rankRange(capture,self);
 // Dominance only; overlapping intervals are not probabilities.
 const kind=c[0]>=e[1]&&(c[0]>e[0]||c[1]>e[1])?'pursue':e[0]>=c[1]&&(e[0]>c[0]||e[1]>c[1])?'escape':null;
 return {kind,escape:e,capture:c,equal:e[0]===e[1]&&c[0]===c[1]&&e[0]===c[0]};
}
module.exports={rank,calculate,rankRange,compare};
