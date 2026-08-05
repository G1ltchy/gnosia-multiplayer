const test = require('node:test');
const assert = require('node:assert/strict');
const { canGnosiaEliminate, engineerInspection, isAngelProtecting, resolveNight } = require('../server');

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
