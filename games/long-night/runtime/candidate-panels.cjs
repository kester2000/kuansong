'use strict';

// Each panel uses only the board and target evidence that existed before sending.
function candidatePanels(report,command,{includeProjection=false}={}){
  const {board,suggestion,self}=report,t=suggestion?.tactic;
  const projection=includeProjection&&board?.opponentProjection;
  const proof=t?.candidates?.exhaustive?t.candidates:projection&&{
    target:projection.player,positions:projection.positions,round:projection.round,partial:projection.partial
  };
  if(!board?.cells||proof?.target==null||proof.target===self||(proof.frame&&proof.frame!==board.frameId))return [];
  const valid=p=>Number.isInteger(p?.r)&&Number.isInteger(p?.c)&&p.r>=0&&p.c>=0&&p.r<board.n&&p.c<board.n;
  if(!valid(board.position)||!proof.positions?.every(valid))return [];
  const positions=[...new Map(proof.positions.map(p=>[p.r+','+p.c,p])).values()];
  if(!positions.length||positions.length>8)return [];
  const player=report.players?.find(p=>p.id===proof.target),other=player?.board;
  const overlay=proof.source==='candidate-alignment'&&!player?.ambiguities&&other?.verified&&valid(other.position)&&other.n===board.n;
  const same=(a,b)=>a?.r===b?.r&&a?.c===b?.c;
  const move=suggestion?.primary,goal=t?.destination,hold=command==='停止'||move?.blocked;
  const next=hold?board.position:move?.to;
  const mod=x=>(x%board.n+board.n)%board.n;
  return positions.map((pos,i)=>{
    const cells=structuredClone(board.cells),births=[];
    for(let r=0;r<board.n;r++)for(let c=0;c<board.n;c++){
      const cell=cells[r][c];
      if(cell.birth&&report.position?.segment===0)births.push({id:self,r,c,label:'本人出生点'});
      if(!overlay)continue;
      const src=other.cells[mod(r-pos.r+other.position.r)][mod(c-pos.c+other.position.c)];
      for(const edge of ['u','d','l','r'])if(cell[edge]==null&&src[edge]!=null){
        cell[edge]=src[edge];
        for(const key of ['wallKinds','collisions','doors'])if(src[key]?.[edge]!=null)(cell[key]??={})[edge]=src[key][edge];
      }
      if(cell.terrain?.length!==1&&src.terrain?.length===1&&(!cell.terrain?.length||cell.terrain.includes(src.terrain[0])))cell.terrain=src.terrain;
      if(src.birth&&player.segment===0)births.push({id:player.id,r,c,label:'假设下的对手出生点'});
    }
    function mark(p,s){if(valid(p))(cells[p.r][p.c].reviewMarks??=[]).push(s);}
    mark(goal,'★');mark(next,'➜');
    let result='若本步走通，仍未到对手所在格';
    if(!valid(next))result='未保存本步的预计落点';
    else if(hold)result=same(pos,next)?'原地结束时与对手同格':'原地结束会扑空';
    else if(same(pos,next))result='若本步走通，会与对手同格';
    else if(same(pos,goal))result='对手在 ★，走到目标格才有机会抓到';
    else if(valid(goal))result='对手不在 ★，只查目标格会扑空';
    return {number:i+1,result,position:pos,target:proof.target,round:proof.round,partial:proof.partial,
      cells,n:board.n,alignment:board.alignment,births,
      markers:[{id:self,...board.position,kind:'current'},{id:proof.target,...pos,kind:'current'}]};
  });
}
module.exports={candidatePanels};
