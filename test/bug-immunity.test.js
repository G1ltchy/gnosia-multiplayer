const test = require('node:test');
const assert = require('node:assert/strict');
const { canGnosiaEliminate } = require('../server');

test('Gnosia attacks cannot eliminate the Bug', () => {
  assert.equal(canGnosiaEliminate({ alive:true, role:'BUG' }), false);
});

test('Gnosia attacks still eliminate an ordinary living target', () => {
  assert.equal(canGnosiaEliminate({ alive:true, role:'CREW' }), true);
  assert.equal(canGnosiaEliminate({ alive:false, role:'CREW' }), false);
});
