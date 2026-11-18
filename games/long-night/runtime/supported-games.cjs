'use strict';
// Only shipped, validated adapters belong here. Candidate games stay in the roadmap.
// Keep the admission check and public help backed by the same list.
const games = Object.freeze([
  Object.freeze({name:'漫漫长夜', description:'自动参赛；加入前核对房间规则；管理员可开单机'}),
]);
const names = Object.freeze(games.map(game => game.name));
function help() {
  return '已支持游戏：' + names.join('、');
}
module.exports = {games, names, help};
