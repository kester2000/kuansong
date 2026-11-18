'use strict';
const {decode}=require('./observation.cjs');
// A non-executing fragment reader used by native-render fixtures. Production
// images are decoded separately and supply the same observable board fields.
function parse(source){const root={tag:'root',attrs:{},children:[]},stack=[root];for(const m of source.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)){const s=m[0];if(s.startsWith('</')){const tag=s.match(/^<\/(\w+)/)[1].toLowerCase();let i=stack.length-1;while(i>0&&stack[i].tag!==tag)i--;if(i>0)stack.length=i;}else if(s[0]==='<'){const tag=s.match(/^<(\w+)/)[1].toLowerCase(),attrs={};for(const a of s.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))attrs[a[1]]=decode(a[2]??a[3]??a[4]);const n={tag,attrs,children:[]};stack.at(-1).children.push(n);if(!/^(img|br|hr|meta|link|input)$/.test(tag)&&!s.endsWith('/>'))stack.push(n);}else stack.at(-1).children.push({text:decode(s)});}return root;}
function all(n,test){const result=[];function visit(x){if(test(x))result.push(x);for(const c of x.children||[])visit(c);}visit(n);return result;}
const has=(n,c)=>(n.attrs?.class||'').split(/\s+/).includes(c),byClass=(n,c)=>all(n,x=>has(x,c));
const text=n=>n.text??(n.children||[]).map(text).join('');
module.exports={parse,all,has,byClass,text};
