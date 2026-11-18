(function longNightModule(root){
 'use strict';
 (root.LongNightSources ||= {})['inference-facts.js']=longNightModule.toString();
 const canonical=value=>JSON.stringify(value);
 function apply(notebook,deductions){
  const base=JSON.parse(canonical(notebook.base));base.config.confirmedEvents=deductions?.events||[];base.config.confirmedBlocks=deductions?.blocks||[];
  return {...notebook,base,choices:Object.fromEntries(Array.from({length:8},(_,p)=>[p,{...(deductions?.choices?.[p]||{}),...(notebook.choices?.[p]||{})}]))};
 }
 const api={apply};if(typeof module!=='undefined')module.exports=api;else root.LongNightFacts=api;
})(globalThis);
