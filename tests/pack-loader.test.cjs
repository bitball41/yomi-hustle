const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {applyPatch, readPack, startGame} = require('../multiplayer/pack-loader.js');
function buffer(file) {
  const data = fs.readFileSync(path.join(__dirname, '..', file));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}
const base = buffer('index.pck');
const patch = buffer('multiplayer/patch.pck');

test('the shipped patch replaces three scripts and preserves all other game resources', () => {
  const original = readPack(base);
  const replacements = readPack(patch);
  const combined = readPack(applyPatch(base, patch));
  assert.equal(replacements.entries.size, 3);
  assert.equal(combined.entries.size, 2774);
  for (const [name, entry] of combined.entries) {
    const source = replacements.entries.has(name) ? replacements : original;
    const expected = source.entries.get(name);
    const bytes = combined.bytes.subarray(entry.offset, entry.offset + entry.size);
    assert.deepEqual(bytes, source.bytes.subarray(expected.offset, expected.offset + expected.size), name);
    assert.deepEqual(new Uint8Array(crypto.createHash('md5').update(bytes).digest()), entry.checksum, name);
  }
});

test('corrupted or truncated packs fail before engine startup', () => {
  assert.throws(() => applyPatch(new ArrayBuffer(20), patch), /Invalid Godot/);
  assert.throws(() => applyPatch(base, patch.slice(0, 100)), /Truncated/);
});

test('an incomplete multiplayer patch fails before engine startup', () => {
  const incomplete = patch.slice(0);
  new DataView(incomplete).setUint32(84, 2, true);
  assert.throws(() => applyPatch(base, incomplete), /Incomplete/);
});

test('the launcher preloads the corrected pack and passes Godot its main pack argument', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async url => ({ok: true, body: null, arrayBuffer: async () => url === 'index.pck' ? base : patch});
  try {
    const engine = {
      async init(name) {calls.push(['init', name]);},
      async preloadFile(data, name) {calls.push(['preload', name]); assert.equal(readPack(data).entries.size, 2774);},
      async start(options) {calls.push(['start', options.args]);},
    };
    await startGame(engine, {}, {executable: 'index', args: [], fileSizes: {}});
    assert.deepEqual(calls, [['init', 'index'], ['preload', 'index.pck'], ['start', ['--main-pack', 'index.pck']]]);
  } finally { global.fetch = originalFetch; }
});
