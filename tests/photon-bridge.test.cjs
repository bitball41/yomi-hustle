const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup() {
  const clients = [], timers = new Map(), messages = [];
  let timerId = 0;
  class Client {
    constructor() {
      this.stateName = 'Uninitialized';
      this.actor = {actorNr: -1, name: '', version: null,
        setName(name) {this.name = name;},
        setCustomProperty(key, value) {this[key] = value;},
        getCustomPropertyOrElse(key, fallback) {return this[key] ?? fallback;}};
      this.actors = [this.actor];
      clients.push(this);
    }
    static StateToName(state) {return state;}
    state(state) {this.stateName = state; this.onStateChange(state);}
    setNameServerAddress(address) {this.address = address;}
    connectToRegionMaster(region) {this.region = region; return true;}
    disconnect() {
      // Exactly the synchronous callback that used to recursively consume all retries.
      this.state('Disconnected');
      this.onError(3001, 'old connection error');
    }
    isInLobby() {return this.stateName === 'JoinedLobby';}
    isJoinedToRoom() {return this.stateName === 'Joined';}
    myActor() {return this.actor;}
    myRoomActorsArray() {return this.actors;}
    myRoom() {return {name: this.roomCode};}
    availableRooms() {return this.rooms || [];}
    createRoom(code, options) {this.roomCode = code; this.roomOptions = options; this.creates = (this.creates || 0) + 1; return this.isInLobby();}
    joinRoom(code) {this.roomCode = code; return this.isInLobby();}
    raiseEvent(code, content, options) {this.sent = {code, content, options};}
  }
  const ctx = vm.createContext({console, Math, JSON,
    setTimeout(fn) {timers.set(++timerId, fn); return timerId;},
    clearTimeout(id) {timers.delete(id);},
    Photon: {ConnectionProtocol: {Wss: 1}, LoadBalancing: {LoadBalancingClient: Client,
      Constants: {OperationCode: {CreateGame: 227, JoinGame: 226},
        ErrorCode: {GameIdAlreadyExists: 32766}, ReceiverGroup: {Others: 0}}}}});
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../multiplayer/photon-bridge.js'), 'utf8'), ctx);
  const bridge = ctx.YomiPhotonBridge;
  bridge.connect('app', '1.1', 'us', value => messages.push(JSON.parse(value)));
  return {bridge, clients, messages, timers};
}

test('a failed attempt retries once even when disconnect calls back synchronously', () => {
  const {bridge, clients, messages} = setup();
  clients[0].state('Error');
  assert.equal(clients.length, 2);
  assert.equal(bridge.client, clients[1]);
  clients[0].onError(3001, 'late error');
  assert.equal(clients.length, 2);
  clients[1].state('JoinedLobby');
  bridge.service();
  assert.equal(messages.filter(m => m.type === 'connection_succeeded').length, 1);
  assert.equal(messages.filter(m => m.type === 'connection_failed').length, 0);
});

test('silent connections time out and eventually report one failure', () => {
  const {bridge, clients, messages, timers} = setup();
  for (let i = 0; i < 3; i++) [...timers.values()][0]();
  bridge.service();
  assert.equal(clients.length, 3);
  assert.equal(timers.size, 0);
  assert.equal(messages.filter(m => m.type === 'connection_failed').length, 1);
  assert.equal(bridge.client, null);
});

test('Godot callbacks wait until poll; disconnect discards queued callbacks', () => {
  const {bridge, clients, messages} = setup();
  clients[0].state('JoinedLobby');
  assert.equal(messages.length, 0);
  bridge.disconnect();
  bridge.service();
  assert.equal(messages.length, 0);
});

test('room registration waits for player version properties', () => {
  const {bridge, clients, messages} = setup();
  const client = clients[0];
  client.state('JoinedLobby');
  bridge.createMatch('Host', false, JSON.stringify('0.13.0'));
  assert.equal(client.roomOptions.maxPlayers, 2);
  assert.equal(client.roomOptions.isVisible, false);
  client.actor.actorNr = 1;
  client.state('Joined');
  const actor = {...client.actor, actorNr: 2, name: 'Guest', version: null};
  client.actors.push(actor);
  client.onActorJoin(actor);
  bridge.service();
  assert.equal(messages.filter(m => m.type === 'player_registered' && m.id === 2).length, 0);
  actor.version = '0.13.0';
  client.onActorPropertiesChange(actor);
  bridge.service();
  assert.equal(messages.filter(m => m.type === 'player_registered' && m.id === 2).length, 1);
});

test('RPC variant bytes remain opaque across Photon; delivery excludes the sender', () => {
  const {bridge, clients, messages} = setup();
  const client = clients[0];
  client.state('Joined');
  const encoded = 'EgAAAAIAAAABAAAAAQAAAAEAAAABAAAA';
  bridge.sendRelayRpc('sync_ids', encoded);
  assert.equal(client.sent.content.arg_b64, encoded);
  assert.equal(client.sent.options.receivers, 0);
  client.onEvent(client.sent.code, client.sent.content);
  bridge.service();
  assert.equal(messages.find(m => m.type === 'relay_rpc').arg_b64, encoded);
  client.onEvent(1, null);
  client.onEvent(1, {function_name: 'sync_ids', arg: null});
  assert.equal(bridge.events.length, 0);
});

test('room codes normalize; a rejected join reports a single recoverable error', () => {
  const {bridge, clients, messages} = setup();
  const client = clients[0];
  client.state('JoinedLobby');
  bridge.joinMatch('Guest', ' abc234 ', JSON.stringify({version: '0.13.0'}));
  assert.equal(client.roomCode, 'ABC234');
  assert.equal(client.actor.version.version, '0.13.0');
  client.onOperationResponse(32758, 'Game does not exist', 226);
  bridge.service();
  assert.equal(messages.filter(m => m.type === 'room_join_deny').length, 1);
  assert.equal(messages.filter(m => m.type === 'game_error').length, 0);
});

test('only name collisions retry room creation, after returning to the lobby', () => {
  const {bridge, clients, messages} = setup();
  const client = clients[0];
  client.state('JoinedLobby');
  bridge.createMatch('Host', true, JSON.stringify('0.13.0'));
  client.state('ConnectedToGameserver');
  client.onOperationResponse(32766, 'Name collision', 227);
  assert.equal(client.creates, 1);
  client.state('JoinedLobby');
  assert.equal(client.creates, 2);
  client.onOperationResponse(32757, 'CCU limit', 227);
  bridge.service();
  assert.equal(client.creates, 2);
  assert.equal(messages.filter(m => m.type === 'game_error').length, 1);
});

test('disconnected users cannot start a room operation', () => {
  const {bridge, clients, messages} = setup();
  bridge.createMatch('Host', true, JSON.stringify('0.13.0'));
  bridge.joinMatch('Guest', 'ABC234', JSON.stringify('0.13.0'));
  bridge.service();
  assert.equal(clients[0].creates, undefined);
  assert.equal(messages.filter(m => m.type === 'game_error').length, 1);
  assert.equal(messages.filter(m => m.type === 'room_join_deny').length, 1);
});
