'use strict';
// A random relocation breaks dependence on earlier coordinates. An uncertain
// portal continuation does not. Missing segment provenance remains blocking.
function hasCurrentAmbiguity(view,node){
 const ambiguities=view?.ambiguities||[];
 if(!ambiguities.length)return false;
 if(node?.verification?.status!=='verified'||node.routePending||node.fusionConflict)return true;
 const active=view.model.active,segments=view.model.segments;
 return ambiguities.some(a=>!Number.isInteger(a.segment)||a.segment>=active||
  !segments.slice(a.segment+1,active+1).some(s=>s.transition==='random'));
}
module.exports={hasCurrentAmbiguity};
