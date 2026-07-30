const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { createClient } = require('redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const ROOM_TTL_SECONDS = Math.max(3600, Number(process.env.ROOM_TTL_SECONDS) || 604800);
let redisClient = null;
let storageReady = !process.env.REDIS_URL;

app.get('/health', (_req, res) => {
  const ok = !process.env.REDIS_URL || storageReady;
  res.status(ok ? 200 : 503).json({
    ok,
    storage: process.env.REDIS_URL ? (storageReady ? 'redis' : 'unavailable') : 'memory',
    rooms: rooms.size
  });
});
app.use(express.static('public', {
  cacheControl: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

const rooms = new Map();
const PHASES = ['LOBBY','ROLE_REVEAL','DISCUSSION','VOTE','VOTE_TALLY','TIE_VOTE','TIE_TALLY','PRIVATE','NIGHT','NIGHT_RESULT','GAME_END'];
const SPECIAL_ROLES = ['engineer','doctor','guard','ac','bug','angel'];

function roomKey(roomCode) {
  return `gnosia:room:${roomCode}`;
}

function storedRoom(room) {
  const copy = JSON.parse(JSON.stringify(room));
  copy.players.forEach(p => { p.socketId = null; });
  return copy;
}

async function persistRoom(room) {
  if (!redisClient?.isReady) return;
  try {
    await redisClient.set(roomKey(room.code), JSON.stringify(storedRoom(room)), { EX: ROOM_TTL_SECONDS });
  } catch (error) {
    console.error(`Failed to persist room ${room.code}:`, error.message);
  }
}

function restoreRoom(room) {
  room.players = Array.isArray(room.players) ? room.players : [];
  room.players.forEach(p => {
    p.socketId = null;
    p.personalLogs = Array.isArray(p.personalLogs) ? p.personalLogs : [];
  });
  room.logs = Array.isArray(room.logs) ? room.logs : [];
  room.voteHistory = Array.isArray(room.voteHistory) ? room.voteHistory : [];
  room.votes ||= {};
  room.tieVotes ||= {};
  room.nightActions ||= {};
  room.privateRooms = Array.isArray(room.privateRooms) ? room.privateRooms : [];
  room.privateLocations ||= {};
  room.privateMessageSince ||= {};
  room.gnosiaMessages = Array.isArray(room.gnosiaMessages) ? room.gnosiaMessages : [];
  room.config = normalizeConfig(room.config);
  return room;
}

async function getRoom(roomCode) {
  if (rooms.has(roomCode)) return rooms.get(roomCode);
  if (!redisClient?.isReady) return null;
  try {
    const data = await redisClient.get(roomKey(roomCode));
    if (!data) return null;
    const room = restoreRoom(JSON.parse(data));
    rooms.set(roomCode, room);
    return room;
  } catch (error) {
    console.error(`Failed to restore room ${roomCode}:`, error.message);
    return null;
  }
}

async function roomExists(roomCode) {
  if (rooms.has(roomCode)) return true;
  if (!redisClient?.isReady) return false;
  return (await redisClient.exists(roomKey(roomCode))) === 1;
}

async function connectStorage() {
  if (!process.env.REDIS_URL) {
    console.warn('REDIS_URL is not set; room state will not survive a restart.');
    return;
  }
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', error => {
    storageReady = false;
    console.error('Redis error:', error.message);
  });
  redisClient.on('ready', () => { storageReady = true; });
  redisClient.on('end', () => { storageReady = false; });
  await redisClient.connect();
  storageReady = true;
  console.log('Redis room storage connected.');
}

const ROLE_INFO = {
  CREW: { label:'선원', faction:'CREW', icon:'crew.png', description:'특별한 능력은 없습니다. 토론과 투표로 그노시아를 찾아내세요.' },
  GNOSIA: { label:'그노시아', faction:'GNOSIA', icon:'gnosia.png', description:'매일 밤 한 명을 소멸시킵니다. 동료 그노시아를 확인할 수 있습니다.' },
  ENGINEER: { label:'엔지니어', faction:'CREW', icon:'engineer.png', description:'매일 밤 한 명을 조사해 인간인지 그노시아인지 판정합니다.' },
  DOCTOR: { label:'닥터', faction:'CREW', icon:'doctor.png', description:'콜드슬립된 플레이어가 인간인지 그노시아인지 판정합니다.' },
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
  const voteResult=room.lastVoteResult&&room.phase==='VOTE_TALLY'?{
    round:room.lastVoteResult.round,maxVotes:room.lastVoteResult.maxVotes,outcome:room.lastVoteResult.outcome,
    candidates:room.lastVoteResult.candidates
  }:undefined;
  const tieVote=room.phase==='TIE_VOTE'?{
    candidates:(room.lastVoteResult?.candidates||[]).filter(c=>c.isTop).map(c=>({id:c.id,nickname:c.nickname}))
  }:room.phase==='TIE_TALLY'?room.lastTieResult:undefined;
  return {
    code:room.code, phase:room.phase, day:room.day, hostId:room.hostId,
    players:room.players.map(p=>({id:p.id,nickname:p.nickname,alive:p.alive,elimination:p.elimination,ready:p.ready,online:!!p.socketId})),
    config:room.config, logs:room.logs.slice(-80), voteHistory:(room.voteHistory||[]).slice(-20), voteRound:room.voteRound,
    submitted:{ votes:Object.keys(room.votes).length, tieVotes:Object.keys(room.tieVotes||{}).length, night:Object.keys(room.nightActions).length },
    winner:room.winner, privateEndsAt:room.privateEndsAt, resultPlayers, voteResult, tieVote
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
    teammateIds:['GNOSIA','GUARD'].includes(p.role)? room.players.filter(x=>x.role===p.role&&x.id!==p.id).map(x=>x.id):[],
    actionSubmitted:!!room.nightActions[p.id], voteSubmitted:!!room.votes[p.id], tieVoteSubmitted:!!room.tieVotes?.[p.id],
    meetingRooms,
    currentRoom:currentRoom?{...currentRoom,messages:(currentRoomData?.messages||[]).filter(m=>m.seq>messageSince)}:null,
    gnosiaMessages:p.role==='GNOSIA'?(room.gnosiaMessages||[]):undefined
  };
}
function emitRoom(room){
  io.to(room.code).emit('state',publicState(room));
  room.players.forEach(p=>{ if(p.socketId) io.to(p.socketId).emit('privateState',privateState(room,p)); });
  void persistRoom(room);
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
  socket.on('createRoom',async ({nickname},cb)=>{
    let c; do c=code(); while(await roomExists(c));
    const p={id:crypto.randomUUID(),token:token(),nickname:nickname.trim().slice(0,20),socketId:socket.id,alive:true,elimination:null,ready:false,role:null,personalLogs:[]};
    const room={code:c,hostId:p.id,players:[p],phase:'LOBBY',day:0,config:{gnosia:1,engineer:true,doctor:true,guard:true,ac:false,bug:false,angel:false},logs:[],voteHistory:[],votes:{},tieVotes:{},voteRound:1,lastVoteResult:null,lastTieResult:null,nightActions:{},lastCold:null,winner:null,privateRooms:[],privateLocations:{},privateMessageSeq:0,privateMessageSince:{},gnosiaMessages:[],privateEndsAt:null};
    rooms.set(c,room); socket.join(c); socket.data.room=c; socket.data.player=p.id; log(room,`${p.nickname}이 방을 만들었습니다.`);
    emitRoom(room); cb?.({ok:true,code:c,token:p.token});
  });

  socket.on('joinRoom',async ({code:raw,nickname,token:resumeToken},cb)=>{
    const c=String(raw||'').toUpperCase(); const room=await getRoom(c); if(!room) return cb?.({ok:false,error:'방을 찾을 수 없습니다.'});
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
    r.phase='ROLE_REVEAL';r.day=1;r.winner=null;r.logs=[];r.voteHistory=[];r.votes={};r.tieVotes={};r.lastVoteResult=null;r.lastTieResult=null;r.nightActions={};r.privateRooms=[];r.privateLocations={};r.privateMessageSeq=0;r.privateMessageSince={};r.gnosiaMessages=[];r.voteRound=1; log(r,'역할이 배정되었습니다. 각자 자신의 역할을 확인하세요.','system'); emitRoom(r); cb?.({ok:true});
  });

  socket.on('returnToLobby',(_,cb)=>{
    const r=rooms.get(socket.data.room); if(!r)return cb?.({ok:false,error:'방을 찾을 수 없습니다.'});
    const p=player(r,socket);
    if(!p||p.id!==r.hostId)return cb?.({ok:false,error:'방장만 대기 로비로 돌아갈 수 있습니다.'});
    if(r.phase!=='GAME_END')return cb?.({ok:false,error:'게임이 종료된 뒤에만 대기 로비로 돌아갈 수 있습니다.'});
    r.players.forEach(x=>{x.role=null;x.alive=true;x.elimination=null;x.ready=false;x.personalLogs=[];});
    r.phase='LOBBY';r.day=0;r.winner=null;r.logs=[];r.voteHistory=[];r.votes={};r.tieVotes={};r.voteRound=1;r.lastVoteResult=null;r.lastTieResult=null;
    r.nightActions={};r.lastCold=null;r.privateRooms=[];r.privateLocations={};r.privateMessageSeq=0;r.privateMessageSince={};
    r.gnosiaMessages=[];r.privateEndsAt=null;
    emitRoom(r);cb?.({ok:true});
  });

  socket.on('advancePhase',({expectedPhase}={},cb)=>{
    const r=rooms.get(socket.data.room), p=player(r,socket);
    if(!r||!p||p.id!==r.hostId)return cb?.({ok:false,error:'방장만 단계를 진행할 수 있습니다.'});
    if(!PHASES.includes(expectedPhase)||r.phase!==expectedPhase){
      return cb?.({ok:false,error:'이미 다음 단계로 진행되었습니다.'});
    }
    if(r.phase==='ROLE_REVEAL'){r.phase='DISCUSSION';log(r,`DAY ${r.day} 토론을 시작합니다.`,'day');}
    else if(r.phase==='DISCUSSION'){r.phase='VOTE';r.votes={};r.tieVotes={};r.lastVoteResult=null;r.lastTieResult=null;r.voteRound=1;log(r,'투표를 시작합니다.','vote');}
    else if(r.phase==='VOTE_TALLY'){
      const result=r.lastVoteResult;if(!result)return;
      r.voteHistory.push({...result,day:r.day});
      log(r,`투표 ${result.round}차: ${result.ballots.map(b=>`${b.voterNickname} → ${b.targetNickname}`).join(' / ')}`,'vote');
      if(result.outcome==='COLD_SLEEP')log(r,`${result.candidates.find(c=>c.isTop)?.nickname}이 콜드슬립되었습니다.`,'cold');
      else log(r,'최다 득표자가 동률입니다. 동률 후보 전원의 콜드슬립 여부를 투표합니다.','vote');
      if(result.outcome==='TIE'){r.tieVotes={};r.lastTieResult=null;r.phase='TIE_VOTE';log(r,'동률 의견 투표를 시작합니다.','vote');}
      else if(winnerCheck(r)){r.phase='GAME_END';log(r,`게임 종료: ${r.winner} 승리`,'end');}
      else {r.phase='PRIVATE';setupPrivateRooms(r);r.privateEndsAt=Date.now()+3*60*1000;log(r,'밀회 시간입니다. 각자의 개인실에서 시작합니다.','private');}
    } else if(r.phase==='TIE_TALLY'){
      const result=r.lastTieResult;if(!result)return;
      log(r,`동률 의견 투표: 모두 콜드슬립 ${result.allCount}표 / 모두 콜드슬립 안 함 ${result.noneCount}표`,'vote');
      log(r,result.decision==='ALL'?'동률 후보 전원이 콜드슬립되었습니다.':'동률 후보 전원을 콜드슬립시키지 않습니다.','cold');
      if(winnerCheck(r)){r.phase='GAME_END';log(r,`게임 종료: ${r.winner} 승리`,'end');}
      else {r.phase='PRIVATE';setupPrivateRooms(r);r.privateEndsAt=Date.now()+3*60*1000;log(r,'밀회 시간입니다. 각자의 개인실에서 시작합니다.','private');}
    } else if(r.phase==='NIGHT'){ resolveNight(r); }
    else if(r.phase==='PRIVATE'){ endPrivate(r); }
    else if(r.phase==='NIGHT_RESULT'){
      if(winnerCheck(r)){r.phase='GAME_END';log(r,`게임 종료: ${r.winner} 승리`,'end');}
      else {r.day++;r.phase='DISCUSSION';log(r,`DAY ${r.day} 토론을 시작합니다.`,'day');}
    }
    emitRoom(r);cb?.({ok:true});
  });

  socket.on('castVote',({targetId},cb)=>{
    const r=rooms.get(socket.data.room), p=player(r,socket); if(!r||!p||r.phase!=='VOTE'||!p.alive)return;
    const t=r.players.find(x=>x.id===targetId&&x.alive); if(!t)return cb?.({ok:false,error:'대상을 선택할 수 없습니다.'});
    if(t.id===p.id)return cb?.({ok:false,error:'자신에게는 투표할 수 없습니다.'});
    r.votes[p.id]=t.id; emitRoom(r);
    if(Object.keys(r.votes).length===alive(r).length) resolveVote(r);
    cb?.({ok:true});
  });

  socket.on('castTieVote',({choice},cb)=>{
    const r=rooms.get(socket.data.room), p=player(r,socket);
    if(!r||!p||r.phase!=='TIE_VOTE'||!p.alive)return cb?.({ok:false,error:'지금은 동률 의견 투표를 할 수 없습니다.'});
    if(!['ALL','NONE'].includes(choice))return cb?.({ok:false,error:'잘못된 의견입니다.'});
    r.tieVotes[p.id]=choice;emitRoom(r);
    if(Object.keys(r.tieVotes).length===alive(r).length)resolveTieVote(r);
    cb?.({ok:true});
  });

  socket.on('nightAction',({targetId},cb)=>{
    const r=rooms.get(socket.data.room), p=player(r,socket); if(!r||!p||r.phase!=='NIGHT'||!p.alive)return;
    if(!['GNOSIA','ENGINEER','ANGEL'].includes(p.role)) return cb?.({ok:false,error:'제출할 행동이 없습니다.'});
    const t=r.players.find(x=>x.id===targetId&&x.alive); if(!t||t.id===p.id&&p.role==='ANGEL')return cb?.({ok:false,error:'잘못된 대상입니다.'});
    if(t.id===p.id&&['GNOSIA','ENGINEER'].includes(p.role))return cb?.({ok:false,error:'자신을 대상으로 지정할 수 없습니다.'});
    if(p.role==='GNOSIA'&&t.role==='GNOSIA')return cb?.({ok:false,error:'그노시아는 소멸 대상으로 지정할 수 없습니다.'});
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
  const voters=alive(r);
  const outcome=tied.length>1?'TIE':'COLD_SLEEP';
  r.lastVoteResult={
    round:r.voteRound,maxVotes:max,outcome,
    candidates:voters.map(p=>({id:p.id,nickname:p.nickname,votes:counts[p.id]||0,isTop:(counts[p.id]||0)===max})),
    ballots:voters.map(v=>{const target=r.players.find(x=>x.id===r.votes[v.id]);return{voterId:v.id,voterNickname:v.nickname,targetId:target?.id,targetNickname:target?.nickname||'-'}})
  };
  if(tied.length>1)r.lastCold=null;
  else {const t=r.players.find(x=>x.id===tied[0]);t.alive=false;t.elimination='COLD_SLEEP';r.lastCold=t.id;}
  if(r.lastCold){r.players.filter(x=>x.role==='DOCTOR'&&x.alive).forEach(d=>personal(d,`${r.players.find(x=>x.id===r.lastCold).nickname}: ${r.players.find(x=>x.id===r.lastCold).role==='GNOSIA'?'그노시아':'인간'}`));}
  r.phase='VOTE_TALLY';emitRoom(r);
}

function resolveTieVote(r){
  const allCount=Object.values(r.tieVotes).filter(choice=>choice==='ALL').length;
  const noneCount=Object.values(r.tieVotes).filter(choice=>choice==='NONE').length;
  const decision=allCount>noneCount?'ALL':'NONE';
  const candidates=(r.lastVoteResult?.candidates||[]).filter(c=>c.isTop);
  if(decision==='ALL'){
    const slept=[];
    candidates.forEach(candidate=>{
      const target=r.players.find(p=>p.id===candidate.id&&p.alive);
      if(target){target.alive=false;target.elimination='COLD_SLEEP';slept.push(target);}
    });
    r.lastCold=slept[0]?.id||null;
    r.players.filter(p=>p.role==='DOCTOR'&&p.alive).forEach(doctor=>{
      slept.forEach(target=>personal(doctor,`${target.nickname}: ${target.role==='GNOSIA'?'그노시아':'인간'}`));
    });
  }else r.lastCold=null;
  r.lastTieResult={allCount,noneCount,decision,candidates:candidates.map(c=>({id:c.id,nickname:c.nickname}))};
  r.phase='TIE_TALLY';emitRoom(r);
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
async function start() {
  await connectStorage();
  server.listen(PORT,'0.0.0.0',()=>console.log(`GNOSIA moderator running on http://localhost:${PORT}`));
}

async function shutdown(signal) {
  console.log(`${signal} received; saving rooms before shutdown.`);
  await Promise.all([...rooms.values()].map(persistRoom));
  await new Promise(resolve => io.close(resolve));
  if (redisClient?.isOpen) await redisClient.quit();
  process.exit(0);
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

start().catch(error => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
