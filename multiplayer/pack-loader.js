(function (root) {
  'use strict';

  function readPack(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const decoder = new TextDecoder();
    if (bytes.length < 88 || view.getUint32(0, true) !== 0x43504447 || view.getUint32(4, true) !== 1) {
      throw new Error('Invalid Godot 3 game pack.');
    }
    const entries = new Map();
    const count = view.getUint32(84, true);
    let cursor = 88;
    function uint64(position) {
      const value = view.getUint32(position, true) + view.getUint32(position + 4, true) * 0x100000000;
      if (!Number.isSafeInteger(value)) throw new Error('Invalid pack offset.');
      return value;
    }
    for (let i = 0; i < count; i++) {
      if (cursor + 4 > bytes.length) throw new Error('Truncated pack directory.');
      const length = view.getUint32(cursor, true);
      cursor += 4;
      if (length > bytes.length - cursor - 32) throw new Error('Truncated pack entry.');
      const name = decoder.decode(bytes.subarray(cursor, cursor + length)).replace(/\0+$/, '');
      cursor += length;
      const offsetPosition = cursor;
      const offset = uint64(cursor);
      const size = uint64(cursor + 8);
      if (offset > bytes.length || size > bytes.length - offset || entries.has(name)) {
        throw new Error('Invalid pack resource: ' + name);
      }
      const checksum = bytes.subarray(cursor + 16, cursor + 32);
      cursor += 32;
      entries.set(name, {offset, size, offsetPosition, checksum});
    }
    return {bytes, entries};
  }

  function applyPatch(baseBuffer, patchBuffer) {
    const base = readPack(baseBuffer);
    const patch = readPack(patchBuffer);
    const allowed = new Set(['res://Network.gdc', 'res://networking/WebsocketClient.gdc', 'res://ui/Lobby.gdc']);
    if (patch.entries.size !== allowed.size) throw new Error('Incomplete multiplayer patch.');
    let size = Math.ceil(base.bytes.length / 16) * 16;
    for (const [name, entry] of patch.entries) {
      if (!allowed.has(name) || !base.entries.has(name)) throw new Error('Unexpected patch resource: ' + name);
      size += Math.ceil(entry.size / 16) * 16;
    }
    const result = new Uint8Array(size);
    result.set(base.bytes);
    const view = new DataView(result.buffer);
    let offset = Math.ceil(base.bytes.length / 16) * 16;
    function uint64(position, value) {
      view.setUint32(position, value >>> 0, true);
      view.setUint32(position + 4, Math.floor(value / 0x100000000), true);
    }
    for (const [name, replacement] of patch.entries) {
      const original = base.entries.get(name);
      result.set(patch.bytes.subarray(replacement.offset, replacement.offset + replacement.size), offset);
      uint64(original.offsetPosition, offset);
      uint64(original.offsetPosition + 8, replacement.size);
      result.set(replacement.checksum, original.offsetPosition + 16);
      offset += Math.ceil(replacement.size / 16) * 16;
    }
    return result.buffer;
  }

  async function download(url, expectedSize, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Unable to load ' + url + ' (' + response.status + ').');
    if (!response.body || !onProgress) return response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, expectedSize || 0);
    }
    const result = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result.buffer;
  }

  async function startGame(engine, options, config) {
    const executable = config.executable;
    const pack = executable + '.pck';
    const [base, patch] = await Promise.all([
      download(pack, config.fileSizes[pack], options.onProgress),
      download('multiplayer/patch.pck'),
      engine.init(executable),
    ]);
    await engine.preloadFile(applyPatch(base, patch), pack);
    return engine.start(Object.assign({}, options, {args: ['--main-pack', pack].concat(config.args || [])}));
  }

  const api = {applyPatch, readPack, startGame};
  root.YomiPackPatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
