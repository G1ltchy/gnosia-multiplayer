const test = require('node:test');
const assert = require('node:assert/strict');
const { canGnosiaEliminate, engineerInspection, isAngelProtecting, resolveNight, normalizeConfig, presetConfig, configuredRoles, drawHiddenRoles, setRoomPassword, verifyRoomPassword } = require('../server');

function nightRoom(players,nightActions){
  return {
    code:'TEST',phase:'NIGHT',day:1,hostId:players[0].id,players,
    config:{},logs:[],voteHistory:[],votes:{},tieVotes:{},nightActions,
    privateRooms:[],privateLocations:{},privateMessageSince:{},gnosiaMessages:[],
    voteRound:1,winner:null,privateEndsAt:null
  };
}

test('Gnosia attacks cannot eliminate the Bug', () => {
  assert.equal(canGnosiaEliminate({ alive:true, role:'BUG' }), false);
});

test('Gnosia attacks still eliminate an ordinary living target', () => {
  assert.equal(canGnosiaEliminate({ alive:true, role:'CREW' }), true);
  assert.equal(canGnosiaEliminate({ alive:false, role:'CREW' }), false);
});

test('Engineer inspection eliminates the Bug but reports Human', () => {
  assert.deepEqual(engineerInspection({ role:'BUG' }), { result:'인간', eliminates:true });
  assert.deepEqual(engineerInspection({ role:'GNOSIA' }), { result:'그노시아', eliminates:false });
});

test('Guardian Angel blocks a Gnosia attack on the protected target', () => {
  const actions=[
    { role:'ANGEL', targetId:'crew-1' },
    { role:'GNOSIA', targetId:'crew-1' }
  ];
  assert.equal(isAngelProtecting(actions,'crew-1'), true);
  assert.equal(isAngelProtecting(actions,'crew-2'), false);
});

test('night resolution eliminates a scanned Bug and records Human', () => {
  const engineer={id:'engineer',nickname:'엔지니어',role:'ENGINEER',alive:true,personalLogs:[]};
  const bug={id:'bug',nickname:'버그',role:'BUG',alive:true,personalLogs:[]};
  const room=nightRoom([engineer,bug],{engineer:{role:'ENGINEER',targetId:'bug'}});
  resolveNight(room);
  assert.equal(bug.alive,false);
  assert.equal(bug.elimination,'VANISHED');
  assert.equal(engineer.personalLogs[0].text,'버그: 인간');
  assert.ok(room.logs.some(entry=>entry.text==='버그이 지난 밤 소멸했습니다.'));
});

test('phase timer settings are normalized and unlimited disables auto advance', () => {
  const config=normalizeConfig({gnosia:1,timers:{DISCUSSION:{seconds:99999,auto:true},VOTE:{seconds:0,auto:true}}});
  assert.deepEqual(config.timers.DISCUSSION,{seconds:3600,auto:true});
  assert.deepEqual(config.timers.VOTE,{seconds:0,auto:false});
  assert.equal(config.timers.PRIVATE.seconds,180);
});

test('AC and Bug toggles create hidden candidates instead of guaranteed public roles', () => {
  const config=normalizeConfig({gnosia:1,engineer:true,ac:true,bug:true});
  assert.deepEqual(configuredRoles(config),['GNOSIA','ENGINEER']);
  assert.deepEqual(drawHiddenRoles(config,()=>false),[]);
  assert.deepEqual(drawHiddenRoles(config,()=>true),['AC','BUG']);
});

test('room passwords are salted, verified, and can be cleared', () => {
  const room={};
  setRoomPassword(room,'secret');
  assert.equal(verifyRoomPassword(room,'secret'),true);
  assert.equal(verifyRoomPassword(room,'wrong'),false);
  assert.equal(JSON.stringify(room).includes('secret'),false);
  setRoomPassword(room,'');
  assert.equal(room.passwordHash,null);
  assert.equal(verifyRoomPassword(room,'anything'),true);
});

test('room presets preserve the intended settings', () => {
  const current=normalizeConfig({gnosia:2,engineer:false,ac:true,bug:false});
  const quick=presetConfig('QUICK',current);
  assert.equal(quick.gnosia,2);
  assert.equal(quick.ac,true);
  assert.deepEqual(quick.timers.PRIVATE,{seconds:120,auto:true});
  const unlimited=presetConfig('UNLIMITED',current);
  assert.ok(Object.values(unlimited.timers).every(setting=>setting.seconds===0&&setting.auto===false));
  const standard=presetConfig('STANDARD',current);
  assert.equal(standard.engineer,true);
  assert.equal(standard.ac,false);
  assert.equal(presetConfig('UNKNOWN',current),null);
});

test('night resolution leaves an Angel-protected target alive', () => {
  const angel={id:'angel',nickname:'천사',role:'ANGEL',alive:true,personalLogs:[]};
  const gnosia={id:'gnosia',nickname:'그노시아',role:'GNOSIA',alive:true,personalLogs:[]};
  const crew={id:'crew',nickname:'선원',role:'CREW',alive:true,personalLogs:[]};
  const room=nightRoom([angel,gnosia,crew],{
    angel:{role:'ANGEL',targetId:'crew'},
    gnosia:{role:'GNOSIA',targetId:'crew'}
  });
  resolveNight(room);
  assert.equal(crew.alive,true);
  assert.equal(crew.elimination,undefined);
  assert.ok(room.logs.some(entry=>entry.text==='지난 밤, 아무도 소멸하지 않았습니다.'));
});
