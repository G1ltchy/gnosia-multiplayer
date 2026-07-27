const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

const rooms = new Map();
const PHASES = ['LOBBY','ROLE_REVEAL','DISCUSSION','VOTE','VOTE_RESULT','PRIVATE','NIGHT','NIGHT_RESULT','GAME_END'];
const SPECIAL_ROLES = ['engineer','doctor','guard','ac','bug','angel'];

const ROLE_INFO = {
  CREW: { label:'선원', faction:'CREW', icon:'crew.png', description:'특별한 능력은 없습니다. 토론과 투표로 그노시아를 찾아내세요.' },
  GNOSIA: { label:'그노시아', faction:'GNOSIA', icon:'gnosia.png', description:'매일 밤 한 명을 소멸시킵니다. 동료 그노시아를 확인할 수 있습니다.' },
  ENGINEER: { label:'엔지니어', faction:'CREW', icon:'engineer.png', description:'매일 밤 한 명을 조사해 인간인지 그노시아인지 판정합니다.' },
  DOCTOR: { label:'의사', faction:'CREW', icon:'doctor.png', description:'콜드슬립된 플레이어가 인간인지 그노시아인지 판정합니다.' },
  GUARD: { label:'선내 대기인', faction:'CREW', icon:'guard.png', description:'두 명이 한 쌍으로 배정되며, 서로가 확정적으로 인간임을 알고 시작합니다.' },
  AC: { label:'AC주의자', faction:'GNOSIA', icon:'ac.png', description:'인간으로 판정되지만 그노시아 진영의 승리를 돕습니다.' },
  BUG: { label:'버그', faction:'BUG', icon:'bug.png', description:'끝까지 생존하면 단독 승리합니다. 엔지니어에게 조사되면 소멸합니다.' },
  ANGEL: { label:'수호천사', faction:'CREW', icon:'angel.png', description:'매일 밤 한 명을 보호합니다. 자신은 보호할 수 없습니다.' }
};

function code() {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<6;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function token(){ return crypto.randomBytes(18).toString('hex'); }
function shuffle(a){ a=[...a]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function player(room, socket){ return room.players.find(p=>p.socketId===socket.id); }
function host(room){ return room.players.find(p=>p.id===room.hostId); }
function alive(room){ return room.players.filter(p=>p.alive); }
function publicState(room){
  const resultPlayers=room.phase==='GAME_END'?room.players.map(p=>{
    const info=ROLE_INFO[p.role]||ROLE_INFO.CREW;
    return {id:p.id,nickname:p.nickname,alive:p.alive,elimination:p.elimination,role:p.role,roleLabel:info.label,faction:info.faction,isWinner:info.faction===room.winner};
  }):undefined;
  return {
    code:room.code, phase:room.phase, day:room.day, hostId:room.hostId,
    players:room.players.map(p=>({id:p.id,nickname:p.nickname,alive:p.alive,elimination:p.elimination,ready:p.ready,online:!!p.socketId})),
    config:room.config, logs:room.logs.slice(-80), voteRound:room.voteRound,
    submitted:{ votes:Object.keys(room.votes).length, night:Object.keys(room.nightActions).length },
    winner:room.winner, privateEndsAt:room.privateEndsAt, resultPlayers
  };
}
function privateState(room,p){
  const info=ROLE_INFO[p.role] || ROLE_INFO.CREW;
  const meetingRooms=(room.privateRooms||[]).map(r=>({
    id:r.id, name:r.name, type:r.type, locked:r.locked, ownerId:r.ownerId
  }));
  const currentRoom=meetingRooms.find(r=>r.id===room.privateLocations?.[p.id]);
  const currentRoomData=(room.privateRooms||[]).find(r=>r.id===currentRoom?.id);
  const messageSince=room.privateMessageSince?.[p.id]||0;
  return {
    id:p.id, token:p.token, nickname:p.nickname, role:p.role, roleInfo:info,
    alive:p.alive, isHost:p.id===room.hostId, personalLogs:p.personalLogs,
    teammates:['GNOSIA','GUARD'].includes(p.role)? room.players.filter(x=>x.role===p.role&&x.id!==p.id).map(x=>x.nickname):[],
    actionSubmitted:!!room.nightActions[p.id], voteSubmitted:!!room.votes[p.id],
    meetingRooms,
    currentRoom:currentRoom?{...currentRoom,messages:(currentRoomData?.messages||[]).filter(m=>m.seq>messageSince)}:null,
    gnosiaMessages:p.role==='GNOSIA'?(room.gnosiaMessages||[]):undefined
  };
}
function emitRoom(room){
  io.to(room.code).emit('state',publicState(room));
  room.players.forEach(p=>{ if(p.socketId) io.to(p.socketId).emit('privateState',privateState(room,p)); });
}
function log(room,text,type='info'){ room.logs.push({day:room.day,text,type,time:Date.now()}); }
function personal(p,text){ p.personalLogs.push({text,time:Date.now()}); }
function normalizeConfig(config = {}) {
  const gnosia = Number(config.gnosia);
  return {
    gnosia: Number.isInteger(gnosia) ? Math.max(1, Math.min(5, gnosia)) : 1,
    ...Object.fromEntries(SPECIAL_ROLES.map(role => [role, config[role] === true]))
  };
}
function configuredRoles(config) {
  return [
    ...Array(config.gnosia).fill('GNOSIA'),
    ...SPECIAL_ROLES.flatMap(role => config[role] ? Array(role === 'guard' ? 2 : 1).fill(role.toUpperCase()) : [])
  ];
}
function setupPrivateRooms(room) {
  const publicRooms=['식당','라운지','창고'].map((name,index)=>({
    id:`public-${index}`,name,type:'PUBLIC',ownerId:null,locked:false,messages:[]
  }));
  const personalRooms=alive(room).map(p=>({
    id:`personal-${p.id}`,name:`${p.nickname}의 개인실`,type:'PERSONAL',ownerId:p.id,locked:false,messages:[]
  }));
  room.privateRooms=[...personalRooms,...publicRooms];
  room.privateLocations=Object.fromEntries(alive(room).map(p=>[p.id,`personal-${p.id}`]));
  room.privateMessageSeq=0;
  room.privateMessageSince=Object.fromEntries(alive(room).map(p=>[p.id,0]));
  room.gnosiaMessages=[];
}

function winnerCheck(room){
  const living=alive(room);
  const bug=living.find(p=>p.role==='BUG');
  const g= living.filter(p=>p.role==='GNOSIA').length;
  const nonG=living.length-g;
  if(g===0){ room.winner=bug?'BUG':'CREW'; return true; }
  if(g>=nonG){ room.winner=bug?'BUG':'GNOSIA'; return true; }
  return false;
}

io.on('connection',(socket)=>{
  socket.on('createRoom',({nickname},cb)=>{
    let c; do c=code(); while(rooms.has(c));
    const p={id:crypto.randomUUID(),token:token(),nickname:nickname.trim().slice(0,20),socketId:socket.id,alive:true,elimination:null,ready:false,role:null,personalLogs:[]};
    const room={code:c,hostId:p.id,players:[p],phase:'LOBBY',day:0,config:{gnosia:1,engineer:true,doctor:true,guard:true,ac:false,bug:false,angel:false},logs:[],votes:{},voteRound:1,nightActions:{},lastCold:null,winner:null,privateRooms:[],privateLocations:{},privateMessageSeq:0,privateMessageSince:{},gnosiaMessages:[],privateEndsAt:null};
    rooms.set(c,room); socket.join(c); socket.data.room=c; socket.data.player=p.id; log(room,`${p.nickname}이 방을 만들었습니다.`);
    emitRoom(room); cb?.({ok:true,code:c,token:p.token});
  });

  socket.on('joinRoom',({code:raw,nickname,token:resumeToken},cb)=>{
    const c=String(raw||'').toUpperCase(); const room=rooms.get(c); if(!room) return cb?.({ok:false,error:'방을 찾을 수 없습니다.'});
    let p=resumeToken?room.players.find(x=>x.token===resumeToken):null;
    if(p){ p.socketId=socket.id; }
    else {
      if(room.phase!=='LOBBY') return cb?.({ok:false,error:'이미 게임이 시작되었습니다.'});
      if(room.players.some(x=>x.nickname===nickname.trim())) return cb?.({ok:false,error:'이미 사용 중인 이름입니다.'});
      p={id:crypto.randomUUID(),token:token(),nickname:nickname.trim().slice(0,20),socketId:socket.id,alive:true,elimination:null,ready:false,role:null,personalLogs:[]};
      room.players.push(p); log(room,`${p.nickname}이 참가했습니다.`);
    }
    socket.join(c); socket.data.room=c; socket.data.player=p.id; emitRoom(room); cb?.({ok:true,code:c,token:p.token});
  });

  socket.on('toggleReady',()=>{ const r=rooms.get(socket.data.room); if(!r)return; const p=player(r,socket); if(!p||r.phase!=='LOBBY')return; p.ready=!p.ready; emitRoom(r); });
  socket.on('updateConfig',(cfg)=>{ const r=rooms.get(socket.data.room); if(!r)return; const p=player(r,socket); if(!p||p.id!==r.hostId||r.phase!=='LOBBY')return; r.config=normalizeConfig(cfg); emitRoom(r); });

  socket.on('startGame',(_,cb)=>{
    const r=rooms.get(socket.data.room); if(!r)return; const p=player(r,socket); if(!p||p.id!==r.hostId)return;
    r.config=normalizeConfig(r.config);
    const roles=configuredRoles(r.config);
    if(roles.length>r.players.length) return cb?.({ok:false,error:`활성화된 역할 수(${roles.length})가 참가자 수(${r.players.length})보다 많습니다.`});
    while(roles.length<r.players.length) roles.push('CREW');
    const mixed=shuffle(roles); r.players.forEach((x,i)=>{x.role=mixed[i];x.alive=true;x.elimination=null;x.personalLogs=[];});
    r.phase='ROLE_REVEAL';r.day=1;r.winner=null;r.logs=[];r.votes={};r.nightActions={};r.privateRooms=[];r.privateLocations={};r.privateMessageSeq=0;r.privateMessageSince={};r.gnosiaMessages=[];r.voteRound=1; log(r,'역할이 배정되었습니다. 각자 자신의 역할을 확인하세요.','system'); emitRoom(r); cb?.({ok:true});
  });

  socket.on('advancePhase',()=>{
    const r=rooms.get(socket.data.room), p=player(r,socket); if(!r||!p||p.id!==r.hostId)return;
    if(r.phase==='ROLE_REVEAL'){r.phase='DISCUSSION';log(r,`DAY ${r.day} 토론을 시작합니다.`,'day');}
    else if(r.phase==='DISCUSSION'){r.phase='VOTE';r.votes={};r.voteRound=1;log(r,'투표를 시작합니다.','vote');}
    else if(r.phase==='VOTE_RESULT'){
      if(winnerCheck(r)){r.phase='GAME_END';log(r,`게임 종료: ${r.winner} 승리`,'end');}
      else {r.phase='PRIVATE';setupPrivateRooms(r);r.privateEndsAt=Date.now()+3*60*1000;log(r,'밀회 시간입니다. 각자의 개인실에서 시작합니다.','private');}
    } else if(r.phase==='NIGHT'){ resolveNight(r); }
    else if(r.phase==='PRIVATE'){ endPrivate(r); }
    else if(r.phase==='NIGHT_RESULT'){
      if(winnerCheck(r)){r.phase='GAME_END';log(r,`게임 종료: ${r.winner} 승리`,'end');}
      else {r.day++;r.phase='DISCUSSION';log(r,`DAY ${r.day} 토론을 시작합니다.`,'day');}
    }
    emitRoom(r);
  });

  socket.on('castVote',({targetId},cb)=>{
    const r=rooms.get(socket.data.room), p=player(r,socket); if(!r||!p||r.phase!=='VOTE'||!p.alive)return;
    const t=r.players.find(x=>x.id===targetId&&x.alive); if(!t)return cb?.({ok:false,error:'대상을 선택할 수 없습니다.'});
    r.votes[p.id]=t.id; emitRoom(r);
    if(Object.keys(r.votes).length===alive(r).length) resolveVote(r);
    cb?.({ok:true});
  });

  socket.on('nightAction',({targetId},cb)=>{
    const r=rooms.get(socket.data.room), p=player(r,socket); if(!r||!p||r.phase!=='NIGHT'||!p.alive)return;
    if(!['GNOSIA','ENGINEER','ANGEL'].includes(p.role)) return cb?.({ok:false,error:'제출할 행동이 없습니다.'});
    const t=r.players.find(x=>x.id===targetId&&x.alive); if(!t||t.id===p.id&&p.role==='ANGEL')return cb?.({ok:false,error:'잘못된 대상입니다.'});
    r.nightActions[p.id]={role:p.role,targetId:t.id}; emitRoom(r); cb?.({ok:true});
  });

  socket.on('movePrivateRoom',({roomId},cb)=>{
    const r=rooms.get(socket.data.room);if(!r)return;const p=player(r,socket);if(!p||r.phase!=='PRIVATE'||!p.alive)return cb?.({ok:false,error:'지금은 방을 이동할 수 없습니다.'});
    const target=r.privateRooms.find(x=>x.id===roomId);if(!target)return cb?.({ok:false,error:'존재하지 않는 방입니다.'});
    if(target.locked&&target.ownerId!==p.id)return cb?.({ok:false,error:'문이 잠겨 있습니다.'});
    r.privateLocations[p.id]=target.id;r.privateMessageSince[p.id]=r.privateMessageSeq;emitRoom(r);cb?.({ok:true});
  });
  socket.on('togglePrivateRoomLock',(_,cb)=>{
    const r=rooms.get(socket.data.room);if(!r)return;const p=player(r,socket);if(!p||r.phase!=='PRIVATE'||!p.alive)return cb?.({ok:false,error:'지금은 문을 잠글 수 없습니다.'});
    const current=r.privateRooms.find(x=>x.id===r.privateLocations[p.id]);
    if(!current||current.type!=='PERSONAL'||current.ownerId!==p.id)return cb?.({ok:false,error:'자신의 개인실 안에서만 문을 잠글 수 있습니다.'});
    current.locked=!current.locked;emitRoom(r);cb?.({ok:true,locked:current.locked});
  });
  socket.on('privateMessage',({text})=>{
    const r=rooms.get(socket.data.room);if(!r)return;const p=player(r,socket);if(!p||r.phase!=='PRIVATE'||!p.alive)return;
    const current=r.privateRooms.find(x=>x.id===r.privateLocations[p.id]);const message=String(text||'').trim().slice(0,500);if(!current||!message)return;
    current.messages.push({seq:++r.privateMessageSeq,from:p.id,nickname:p.nickname,text:message,time:Date.now()});current.messages=current.messages.slice(-100);emitRoom(r);
  });
  socket.on('gnosiaMessage',({text})=>{
    const r=rooms.get(socket.data.room);if(!r)return;const p=player(r,socket);if(!p||r.phase!=='PRIVATE'||!p.alive||p.role!=='GNOSIA')return;
    const message=String(text||'').trim().slice(0,500);if(!message)return;
    r.gnosiaMessages.push({from:p.id,nickname:p.nickname,text:message,time:Date.now()});r.gnosiaMessages=r.gnosiaMessages.slice(-100);emitRoom(r);
  });

  socket.on('disconnect',()=>{ const r=rooms.get(socket.data.room); if(!r)return; const p=r.players.find(x=>x.id===socket.data.player);if(p)p.socketId=null;emitRoom(r); });
});

function resolveVote(r){
  const counts={};Object.values(r.votes).forEach(id=>counts[id]=(counts[id]||0)+1);
  const max=Math.max(...Object.values(counts));const tied=Object.keys(counts).filter(id=>counts[id]===max);
  const lines=alive(r).map(v=>`${v.nickname} → ${r.players.find(x=>x.id===r.votes[v.id])?.nickname}`).join(' / ');
  log(r,`투표 ${r.voteRound}차: ${lines}`,'vote');
  if(tied.length>1&&r.voteRound<3){r.voteRound++;r.votes={};log(r,`동률입니다. ${r.voteRound}차 재투표를 실시합니다.`,'vote');emitRoom(r);return;}
  if(tied.length>1){log(r,'3차 투표도 동률이므로 누구도 콜드슬립되지 않습니다.','vote');r.lastCold=null;}
  else {const t=r.players.find(x=>x.id===tied[0]);t.alive=false;t.elimination='COLD_SLEEP';r.lastCold=t.id;log(r,`${t.nickname}이 콜드슬립되었습니다.`,'cold');}
  if(r.lastCold){r.players.filter(x=>x.role==='DOCTOR'&&x.alive).forEach(d=>personal(d,`${r.players.find(x=>x.id===r.lastCold).nickname}: ${r.players.find(x=>x.id===r.lastCold).role==='GNOSIA'?'그노시아':'인간'}`));}
  r.phase='VOTE_RESULT';emitRoom(r);
}

function resolveNight(r){
  const actions=Object.values(r.nightActions);
  const eng=actions.filter(a=>a.role==='ENGINEER');
  eng.forEach(a=>{const actor=r.players.find(x=>r.nightActions[x.id]===a);const target=r.players.find(x=>x.id===a.targetId);if(target.role==='BUG'){target.alive=false;target.elimination='VANISHED';personal(actor,`${target.nickname}: 버그 소멸`);log(r,`${target.nickname}이 흔적도 없이 사라졌습니다.`,'night');}else personal(actor,`${target.nickname}: ${target.role==='GNOSIA'?'그노시아':'인간'}`);});
  const guards=new Set(actions.filter(a=>a.role==='ANGEL').map(a=>a.targetId));
  const attacks=actions.filter(a=>a.role==='GNOSIA').map(a=>a.targetId);
  let victim=null;if(attacks.length){const freq={};attacks.forEach(id=>freq[id]=(freq[id]||0)+1);victim=Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0];}
  if(victim&&guards.has(victim))log(r,'지난 밤, 아무도 소멸하지 않았습니다.','night');
  else if(victim){const v=r.players.find(x=>x.id===victim);if(v&&v.alive&&v.role!=='GNOSIA'){v.alive=false;v.elimination='VANISHED';log(r,`${v.nickname}이 지난 밤 소멸했습니다.`,'night');}else log(r,'지난 밤, 아무도 소멸하지 않았습니다.','night');}
  else log(r,'지난 밤, 아무도 소멸하지 않았습니다.','night');
  r.phase='NIGHT_RESULT';log(r,'밤의 결과가 공개되었습니다.','night');emitRoom(r);
}
function endPrivate(r){ r.privateRooms=[];r.privateLocations={};r.privateMessageSeq=0;r.privateMessageSince={};r.gnosiaMessages=[];r.privateEndsAt=null;r.nightActions={};r.phase='NIGHT';log(r,'밀회가 종료되고 밤이 되었습니다. 역할 행동을 제출하세요.','night'); }

const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>console.log(`GNOSIA moderator running on http://localhost:${PORT}`));
