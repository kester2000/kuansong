#include <iostream>
#include <fstream>
#include <nlohmann/json.hpp>
#include "game_framework/mock_match.h"
#include "game_framework/game_options.h"
#include "game_framework/game_main.h"
#include "game_framework/stage.h"
using json=nlohmann::json;
unsigned arena_seed=1;
char _binary_rule_md_start[]={0};
void* arena_main=nullptr;
void* arena_round=nullptr;
// Compatibility aliases for the newer game's namespaced framework types.
namespace lgtbot { using ::PlayerID; using ChildMsgSenderBase = ::MsgSenderBase; using ::At; using ::Markdown; }
#include "source/_arena_mygame.cc"
namespace game=lgtbot::game::long_night;
extern bool enable_markdown_to_image;
static json arena_messages=json::array();
// Audit output is isolated from the journals passed to the policy. These are
// request boundaries (a batched command can contain several internal moves).
static json Truth(const Board& b) {
 json cells=json::array(),players=json::array();
 for(int x=0;x<b.size;x++)for(int y=0;y<b.size;y++){
  const auto& c=b.grid_map[x][y];json walls=json::array(),buttons=json::array();
  for(auto d:{Direct::UP,Direct::DOWN,Direct::LEFT,Direct::RIGHT}){
   const auto& w=b.grid_map.WallAt(x,y,d);
   walls.push_back({{"type",static_cast<int>(w.Type())},{"attach",static_cast<int>(w.Attach())},{"count",w.Count()},{"label",w.Label()}});
  }
  for(const auto& t:c.ButtonTargetPos())buttons.push_back({{"dx",t.dx},{"dy",t.dy},{"direction",t.dir?static_cast<int>(*t.dir):-1}});
  cells.push_back({{"x",x},{"y",y},{"type",static_cast<int>(c.Type())},{"attach",static_cast<int>(c.Attach())},{"portalOffset",c.PortalPos()},{"trapActive",c.TrapStatus()},{"buttons",buttons},{"walls",walls}});
 }
 for(const auto& p:b.players)players.push_back({{"id",p.pid.Get()},{"x",p.x},{"y",p.y},{"out",p.out},{"target",p.target.Get()},{"subspace",p.subspace},{"coins",p.coins},{"heated",p.heated},{"inHeatZone",p.in_heat_zone},{"score",p.score.FinalScore()},{"scoreParts",{{"capture",p.score.catch_score},{"escape",p.score.exit_score},{"coins",p.score.coin_score},{"blocks",p.score.BlockScore()},{"exploration",p.score.ExploreScore()},{"quit",p.score.quit_score}}}});
 return {{"schema",1},{"coordinateSystem","zero-based row,column"},{"wallOrder",{"up","down","left","right"}},
  {"enumSource","native/source/common/constants.h"},{"granularity","referee-request-boundary"},{"bossStateIncluded",false},
  {"size",b.size},{"exitCount",b.exit_num},{"cells",cells},{"players",players}};
}
class Sender:public MockMsgSender {
 int recipient;
 public: Sender(int to=-1):MockMsgSender(""),recipient(to){}
 private: void Flush(std::vector<MsgFragment>&& parts) const override {
  std::stringstream s;
  for(auto& p:parts)std::visit(Overload{
   [&](const std::string& t){s<<t;},
   [&](const At<PlayerID>& a){s<<"@"<<a.id_.Get();},
   [&](const Name<PlayerID>& a){s<<"[PLAYER_"<<a.id_.Get()<<"]";},
   [&](const Markdown&){},[&](const Image&){},
   [&](const At<UserID>&){},[&](const Name<UserID>&){}
  },p);
  if(!s.str().empty())arena_messages.push_back({{"to",recipient},{"text",s.str()},{"round",arena_main?static_cast<game::MainStage*>(arena_main)->round_:0}});
 }
};
class Match:public MockMatch {
 Sender pub;std::vector<std::unique_ptr<Sender>> priv;
 public: Match(int n):MockMatch("",n){for(int i=0;i<n;i++)priv.push_back(std::make_unique<Sender>(i));}
 MsgSenderBase& BoardcastMsgSender() override{return pub;}
 MsgSenderBase& TellMsgSender(PlayerID p) override{return *priv.at(p.Get());}
 MockMsgSender& GroupMsgSender() override{return pub;}
 MsgSenderBase& BoardcastAiInfoMsgSender() override{return pub;}
};
int main(){
 enable_markdown_to_image=false;
 std::string line;
 std::unique_ptr<game::GameOptions> options;
 std::unique_ptr<lgtbot::game::GenericOptions> generic;
 std::unique_ptr<Match> match;
 std::unique_ptr<game::internal::MainStage> stage;
 int n=0;bool audit=false;Sender reply;
 while(std::getline(std::cin,line))try{
  arena_messages=json::array();auto q=json::parse(line);std::string op=q.value("op","");
  if(op=="init"){
   stage.reset();match.reset();arena_main=nullptr;arena_round=nullptr;
   arena_seed=q.at("seed").get<unsigned>();std::srand(arena_seed);n=q.at("players");audit=q.value("audit",false);
   if(n<2||n>8)throw std::runtime_error("players must be 2..8");
   options=std::make_unique<game::GameOptions>();
   for(const auto& o:q.at("options"))if(!options->SetOption(o.get<std::string>().c_str()))throw std::runtime_error("invalid option: "+o.get<std::string>());
   generic=std::make_unique<lgtbot::game::GenericOptions>(lgtbot::game::GenericOptions{lgtbot::game::ImmutableGenericOptions{.user_num_=static_cast<uint32_t>(n),.resource_dir_="",.saved_image_dir_=""},lgtbot::game::MutableGenericOptions{}});
   if(!game::AdaptOptions(reply,*options,*generic,*generic))throw std::runtime_error("unsupported option combination");
   match=std::make_unique<Match>(n);
   stage.reset(game::MakeMainStage(game::MainStageFactory{*options,*generic,*match}));
   if(!stage)throw std::runtime_error("stage creation failed");
   stage->HandleStageBegin();
  }else if(op=="act"){
   if(!stage||stage->IsOver())throw std::runtime_error("no live game");
   int pid=q.at("player");auto* turn=static_cast<game::RoundStage*>(arena_round);
   if(pid!=turn->currentPlayer.Get())throw std::runtime_error("wrong actor");
   std::string action=q.at("action");
   auto rc=stage->HandleRequest(action.c_str(),pid,true,reply);
   if(rc==StageErrCode::FAILED||rc==StageErrCode::NOT_FOUND)throw std::runtime_error("rejected action");
   if(!stage->IsOver())stage->HandleRequest("赛况 文字",pid,true,reply);
  }else if(op=="timeout"){
   if(!stage||stage->IsOver())throw std::runtime_error("no live game");
   auto* turn=static_cast<game::RoundStage*>(arena_round);
   if(q.at("player").get<int>()!=turn->currentPlayer.Get())throw std::runtime_error("wrong actor");
   stage->HandleTimeout();
  }else throw std::runtime_error("unknown op");
  auto* main=static_cast<game::MainStage*>(arena_main);
  json out={{"ok",true},{"over",stage->IsOver()},{"round",main->round_},{"messages",arena_messages}};
  if(audit)out["truth"]=Truth(main->board);
  if(!stage->IsOver()){auto* t=static_cast<game::RoundStage*>(arena_round);out["actor"]=t->currentPlayer.Get();out["step"]=t->step;}
  if(op=="init"){
   out["pool"]=json::array();for(const auto& b:main->board.unitMaps.maps)out["pool"].push_back(b.id);for(const auto& b:main->board.unitMaps.exits)out["pool"].push_back("E"+b.id);
  }
  if(stage->IsOver()){
   out["scores"]=json::array();out["out"]=json::array();
   for(int i=0;i<n;i++){out["scores"].push_back(stage->PlayerScore(i));out["out"].push_back(main->board.players[i].out);}
  }
  std::cout<<out.dump()<<std::endl;
 }catch(const std::exception& e){std::cout<<json({{"ok",false},{"error",e.what()}}).dump()<<std::endl;}
}
