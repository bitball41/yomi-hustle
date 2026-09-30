
(function () {
  if (window.YomiPhotonBridge) {
	return;
  }

  var EVENT_CODE = 1;

  function cloneList(items) {
	return items ? items.slice() : [];
  }

  window.YomiPhotonBridge = {
	client: null,
	callback: null,
	events: [],
	connectionTimer: null,
	connectionTimeoutMs: 12000,
	retryRoomCreation: false,
	onlinePlayerCount: 0,
	connectedOnce: false,
	createRetryCount: 0,
	pendingRoomCode: "",
	pendingPublicMatch: true,
	pendingVersion: null,
	pendingPlayerName: "",
	pendingAppId: "",
	pendingAppVersion: "",
	pendingRegion: "US",
	connectAttemptIndex: 0,
	nameServerAddresses: ["wss://ns.photonindustries.io:443", "wss://ns.photonengine.io:443", "wss://ns.photonengine.io:19093"],

	_emit: function (payload) {
	  // Drain from Godot's poll, after constructors and signal listeners are ready.
	  if (this.callback) this.events.push(JSON.stringify(payload));
	},

	_myActorId: function () {
	  if (!this.client || !this.client.myActor()) {
		return 0;
	  }
	  return Math.max(0, this.client.myActor().actorNr || 0);
	},

	_emitConnectionEnded: function () {
	  this._emit({
		type: "connection_ended",
		client_id: this._myActorId()
	  });
	},

	_emitConnectionFailed: function (message) {
	  this._emit({
		type: "connection_failed",
		message: message || "Photon connection failed.",
		client_id: this._myActorId()
	  });
	},

	_roomListPayload: function () {
	  if (!this.client || !this.client.availableRooms) {
		return [];
	  }

	  return this.client
		.availableRooms()
		.filter(function (room) {
		  return room && !room.removed && room.isVisible && room.isOpen && room.playerCount < 2;
		})
		.map(function (room) {
		  return {
			host: room.getCustomPropertyOrElse("host", "Host"),
			code: room.name
		  };
		});
	},

	_emitRoomList: function () {
	  this._emit({
		type: "match_list",
		list: this._roomListPayload(),
		client_id: this._myActorId()
	  });
	},

	_emitPlayerCount: function () {
	  var total = this.onlinePlayerCount;
	  this._emit({
		type: "player_count",
		count: total,
		client_id: this._myActorId()
	  });
	},

	_emitRegisterSync: function () {
	  if (!this.client || !this.client.isJoinedToRoom || !this.client.isJoinedToRoom()) {
		return;
	  }

	  var actors = cloneList(this.client.myRoomActorsArray());
	  actors.sort(function (a, b) {
		return a.actorNr - b.actorNr;
	  });

	  for (var i = 0; i < actors.length; i += 1) {
		var actor = actors[i];
		var version = actor.getCustomPropertyOrElse("version", null);
		if (version === null) continue;
		this._emit({
		  type: "player_registered",
		  name: actor.name || ("Player " + actor.actorNr),
		  id: actor.actorNr,
		  version: version,
		  client_id: this._myActorId()
		});
	  }
	},

	_createRoomWithRetry: function () {
	  if (!this.client || !this.client.isInLobby()) {
		this.retryRoomCreation = true;
		return;
	  }
	  this.retryRoomCreation = false;

	  this.pendingRoomCode = this._randomRoomCode();
	  var started = this.client.createRoom(this.pendingRoomCode, {
		isVisible: this.pendingPublicMatch,
		isOpen: true,
		maxPlayers: 2,
		customGameProperties: {
		  host: this.pendingPlayerName,
		  version: this.pendingVersion,
		  public: this.pendingPublicMatch
		},
		propsListedInLobby: ["host", "version", "public"]
	  });
	  if (!started) this._emit({type: "game_error", message: "Unable to create room. Reconnect and try again."});
	},

	_randomRoomCode: function () {
	  var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	  var code = "";
	  for (var i = 0; i < 6; i += 1) {
		code += alphabet[Math.floor(Math.random() * alphabet.length)];
	  }
	  return code;
	},

	_currentNameServerAddress: function () {
	  return this.nameServerAddresses[Math.min(this.connectAttemptIndex, this.nameServerAddresses.length - 1)];
	},

	_retryConnection: function () {
	  if (this.connectedOnce || this.connectAttemptIndex + 1 >= this.nameServerAddresses.length) {
		return false;
	  }
	  this.connectAttemptIndex += 1;
	  this._clearConnectionTimer();
	  var oldClient = this.client;
	  // Invalidate callbacks before disconnect: Photon fires state changes synchronously.
	  this.client = null;
	  try {
		if (oldClient) oldClient.disconnect();
	  } catch (_error) {
	  }
	  this._connectClient();
	  return true;
	},

	_clearConnectionTimer: function () {
	  if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
	  this.connectionTimer = null;
	},

	_connectionProblem: function (client, message) {
	  if (this.client !== client) return;
	  if (!this.connectedOnce && this._retryConnection()) return;
	  this._clearConnectionTimer();
	  this.client = null;
	  try { client.disconnect(); } catch (_error) {}
	  if (this.connectedOnce) this._emitConnectionEnded();
	  else this._emitConnectionFailed(message);
	},

	_connectClient: function () {
	  var LBC = Photon.LoadBalancing.LoadBalancingClient;
	  var self = this;
	  var client = new LBC(Photon.ConnectionProtocol.Wss, this.pendingAppId, this.pendingAppVersion);
	  client.autoJoinLobby = true;
	  if (client.setNameServerAddress) {
		client.setNameServerAddress(this._currentNameServerAddress());
	  }

	  client.onStateChange = function (state) {
		if (self.client !== client) {
		  return;
		}
		var stateName = LBC.StateToName(state);
		if (stateName === "JoinedLobby") {
		  self._clearConnectionTimer();
		  if (!self.connectedOnce) {
			self.connectedOnce = true;
			self._emit({type: "connection_succeeded", client_id: self._myActorId()});
		  }
		  self._emitRoomList();
		  self._emitPlayerCount();
		  if (self.retryRoomCreation) self._createRoomWithRetry();
		} else if (stateName === "Disconnected" || stateName === "Error") {
		  self._connectionProblem(client, "Photon disconnected before joining the lobby.");
		}
	  };

	  client.onRoomList = function () {
		if (self.client !== client) {
		  return;
		}
		self._emitRoomList();
		self._emitPlayerCount();
	  };

	  client.onAppStats = function (errorCode, _message, stats) {
		if (self.client !== client || errorCode || !stats) return;
		self.onlinePlayerCount = (stats.peerCount || 0) + (stats.masterPeerCount || 0);
		self._emitPlayerCount();
	  };

	  client.onRoomListUpdate = function () {
		if (self.client !== client) {
		  return;
		}
		self._emitRoomList();
		self._emitPlayerCount();
	  };

	  client.onJoinRoom = function (createdByMe) {
		if (self.client !== client) {
		  return;
		}
		if (createdByMe) {
		  self.createRetryCount = 0;
		  self._emit({
			type: "match_created",
			code: client.myRoom().name,
			client_id: self._myActorId()
		  });
		} else {
		  self._emit({
			type: "room_join_confirm",
			client_id: self._myActorId()
		  });
		}
		self._emitRegisterSync();
	  };

	  client.onActorJoin = function () {
		if (self.client !== client) {
		  return;
		}
		self._emitRegisterSync();
		self._emitPlayerCount();
	  };

	  client.onActorPropertiesChange = function () {
		if (self.client === client) self._emitRegisterSync();
	  };

	  client.onActorLeave = function (actor) {
		if (self.client !== client) {
		  return;
		}
		self._emit({
		  type: "peer_disconnected",
		  id: actor.actorNr,
		  client_id: self._myActorId()
		});
		self._emitPlayerCount();
	  };

	  client.onEvent = function (code, content) {
		if (self.client !== client || code !== EVENT_CODE || !content ||
			typeof content.function_name !== "string" || typeof content.arg_b64 !== "string") {
		  return;
		}
		self._emit({
		  type: "relay_rpc",
		  function_name: content.function_name,
		  arg_b64: content.arg_b64,
		  client_id: self._myActorId()
		});
	  };

	  client.onOperationResponse = function (errorCode, errorMsg, code) {
		if (self.client !== client || !errorCode) {
		  return;
		}

		var op = Photon.LoadBalancing.Constants.OperationCode;
		if (code === op.CreateGame && errorCode === Photon.LoadBalancing.Constants.ErrorCode.GameIdAlreadyExists && self.createRetryCount < 5) {
		  self.createRetryCount += 1;
		  self._createRoomWithRetry();
		  return;
		}

		if (code === op.JoinGame) {
		  self._emit({
			type: "room_join_deny",
			message: errorMsg || "Unable to join room.",
			client_id: self._myActorId()
		  });
		  return;
		}

		self._emit({
		  type: "game_error",
		  message: errorMsg || "Photon operation failed.",
		  client_id: self._myActorId()
		});
	  };

	  client.onError = function (errorCode, errorMsg) {
		self._connectionProblem(client, errorMsg || ("Photon error " + errorCode));
	  };

	  this.client = client;
	  this.connectionTimer = setTimeout(function () {
		self._connectionProblem(client, "Photon connection timed out.");
	  }, this.connectionTimeoutMs);
	  try {
		if (!client.connectToRegionMaster(this.pendingRegion || "US")) {
		  this._connectionProblem(client, "Unable to start Photon connection.");
		}
	  } catch (error) {
		this._connectionProblem(client, String(error));
	  }
	},

	connect: function (appId, appVersion, region, callback) {
	  this.disconnect();
	  this.callback = callback;
	  this.connectedOnce = false;
	  this.createRetryCount = 0;
	  this.connectAttemptIndex = 0;
	  this.pendingRoomCode = "";
	  this.pendingPlayerName = "";
	  this.pendingVersion = null;
	  this.pendingAppId = appId;
	  this.pendingAppVersion = appVersion;
	  this.pendingRegion = String(region || "US").toUpperCase();

	  try {
		this._connectClient();
	  } catch (error) {
		this._emitConnectionFailed(String(error));
	  }
	},

	disconnect: function () {
	  this._clearConnectionTimer();
	  var oldClient = this.client;
	  this.client = null;
	  this.callback = null;
	  this.events = [];
	  this.retryRoomCreation = false;
	  this.onlinePlayerCount = 0;
	  if (oldClient) {
		try {
		  oldClient.disconnect();
		} catch (_error) {
		}
	  }
	  this.connectedOnce = false;
	},

	createMatch: function (playerName, publicMatch, version) {
	  if (!this.client || !this.client.isInLobby()) {
		this._emit({type: "game_error", message: "Not connected to the lobby. Reconnect and try again."});
		return;
	  }
	  version = JSON.parse(version);
	  this.pendingPlayerName = playerName;
	  this.pendingPublicMatch = !!publicMatch;
	  this.pendingVersion = version;
	  this.createRetryCount = 0;
	  this.client.myActor().setName(playerName);
	  this.client.myActor().setCustomProperty("version", version);
	  this._createRoomWithRetry();
	},

	joinMatch: function (playerName, roomCode, version) {
	  if (!this.client || !this.client.isInLobby()) {
		this._emit({type: "room_join_deny", message: "Not connected to the lobby. Reconnect and try again."});
		return;
	  }
	  version = JSON.parse(version);
	  this.pendingPlayerName = playerName;
	  this.pendingVersion = version;
	  this.client.myActor().setName(playerName);
	  this.client.myActor().setCustomProperty("version", version);
	  if (!this.client.joinRoom(String(roomCode || "").trim().toUpperCase())) {
		this._emit({type: "room_join_deny", message: "Unable to join room. Reconnect and try again."});
	  }
	},

	requestMatchList: function () {
	  this._emitRoomList();
	},

	requestPlayerCount: function () {
	  this._emitPlayerCount();
	},

	sendRelayRpc: function (functionName, argBase64) {
	  if (!this.client || !this.client.isJoinedToRoom || !this.client.isJoinedToRoom()) {
		return;
	  }
	  this.client.raiseEvent(EVENT_CODE, {
		function_name: functionName,
		arg_b64: argBase64
	  }, {receivers: Photon.LoadBalancing.Constants.ReceiverGroup.Others});
	},

	service: function () {
	  var callback = this.callback;
	  var batch = this.events;
	  this.events = [];
	  for (var i = 0; i < batch.length && this.callback === callback; i += 1) {
		if (callback) callback(batch[i]);
	  }
	}
  };
})();
