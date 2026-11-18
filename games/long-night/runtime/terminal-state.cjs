'use strict';
const K=require('../night-strategist/kernel.cjs');
function terminalState(journal,board){
 const {result,status,own,ended}=require('../night-strategist/outcome.cjs').outcome(journal);
 if(!ended)return {board,result:board.review?.result||result};
 const report=board.report?{...board.report,status:own,players:board.report.players?.map(p=>({...p,status:status.find(s=>s.id===p.id)||p.status}))}:board.report;
 return {result,board:{...board,report,review:{...board.review,result}}};
}
module.exports={terminalState};
