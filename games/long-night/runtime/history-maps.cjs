'use strict';
// Presentation only: past proofs must never become current movement evidence.
function historyMaps(data){
 const current=new Map((data.report?.players||[]).flatMap(p=>(p.segments||[]).map(s=>[`${p.id}:${s.index}`,new Set((s.board?.blocks||[]).map(b=>b.id))])));
 const saved=new Map();
 for(const d of data.decisions||[])for(const p of d.report?.players||[])for(const s of p.segments||[]){
  const board=s.board,key=`${p.id}:${s.index}`;
  if(!board?.verified||!board.blocks?.length)continue;
  if(!board.blocks.some(b=>!current.get(key)?.has(b.id)))continue;
  const old=saved.get(key);
  if(!old||board.blocks.length>=old.board.blocks.length)saved.set(key,{player:p.id,index:s.index,at:d.at,board});
 }
 return [...saved.values()];
}
module.exports={historyMaps};
