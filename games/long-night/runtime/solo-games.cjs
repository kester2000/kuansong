'use strict';
// Creation is routed by game. New solo adapters can be added independently of
// the multiplayer router and the long-night option grammar.
const adapters=new Map([['漫漫长夜',require('./solo-options.cjs')]]);
function parse(body){
 if(/[\r\n\x00-\x1f]/.test(body))throw Error('单机指令须写在一行，用空格分隔参数');
 const parts=String(body).trim().split(/\s+/),verb=parts.shift();
 let game='漫漫长夜';
 if(adapters.has(parts[0]))game=parts.shift();
 return {...adapters.get(game).parse([verb,...parts].join(' ')),game};
}
function mismatches(request,actual){return adapters.get(request.game).mismatches(request,actual);}
module.exports={parse,mismatches};
