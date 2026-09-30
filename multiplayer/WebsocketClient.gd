extends Reference

class_name MultiplayerClient

const PHOTON_APP_ID: = "ece6c606-0eb1-45d4-b0b9-938d3d47e54c"
const PHOTON_APP_VERSION: = "1.1"
const PHOTON_REGION: = "us"
const PhotonSdkSource = preload("res://networking/PhotonSdkSource.gd")
# tools/build_multiplayer.py embeds photon-bridge.js into the exported script.
const PHOTON_BRIDGE_SOURCE = ""

var _client: = WebSocketClient.new()
var _is_web: = false
var _window = null
var _photon_bridge = null
var _photon_callback = null

var connected: = false
var address: = ""
var client_id: = 0
var _closing: = false

signal connection_ended()
signal connection_failed()
signal connection_succeeded()
signal message_received(message)

func _init(new_address):
	address = str(new_address)
	_is_web = OS.has_feature("HTML5") or OS.has_feature("JavaScript")
	if _is_web:
		_init_photon_client()
	else:
		_init_websocket_client()

func _init_websocket_client():
	_client.connect("connection_closed", self, "_closed", [], CONNECT_DEFERRED)
	_client.connect("connection_error", self, "_connection_error", [], CONNECT_DEFERRED)
	_client.connect("connection_established", self, "_connected", [], CONNECT_DEFERRED)
	_client.connect("data_received", self, "_on_data_received", [], CONNECT_DEFERRED)

	var err = _client.connect_to_url(address, PoolStringArray(), false)
	if err != OK:
		print("Unable to connect")
		emit_signal("connection_failed")

func _init_photon_client():
	if not _load_photon_sdk():
		emit_signal("connection_failed")
		return
	_install_photon_bridge()
	_window = JavaScript.get_interface("window")
	_photon_bridge = _window.YomiPhotonBridge
	_photon_callback = JavaScript.create_callback(self, "_on_photon_callback")
	_photon_bridge.connect(PHOTON_APP_ID, PHOTON_APP_VERSION, PHOTON_REGION, _photon_callback)

func _load_photon_sdk() -> bool:
	var loaded = JavaScript.eval("typeof Photon !== 'undefined'", true)
	if bool(loaded):
		return true
	var source = PhotonSdkSource.get_source()
	if source.strip_edges() == "":
		push_error("Photon SDK source is empty.")
		return false
	JavaScript.eval(source, true)
	return bool(JavaScript.eval("typeof Photon !== 'undefined'", true))

func _install_photon_bridge():
	var installed = JavaScript.eval("typeof window.YomiPhotonBridge !== 'undefined'", true)
	if bool(installed):
		return
	JavaScript.eval(PHOTON_BRIDGE_SOURCE, true)

func _on_photon_callback(args):
	if args.empty():
		return
	var payload = str(args[0])
	var message = parse_json(payload)
	if typeof(message) != TYPE_DICTIONARY:
		return
	if message.has("client_id"):
		client_id = int(message["client_id"])
	var message_type = str(message.get("type", ""))
	match message_type:
		"connection_succeeded":
			connected = true
			_closing = false
			emit_signal("connection_succeeded")
		"connection_failed":
			closing_cleanup()
			emit_signal("connection_failed")
		"connection_ended":
			closing_cleanup()
			emit_signal("connection_ended")
		"relay_rpc":
			if not message.has("arg_b64") or not message["arg_b64"] is String:
				return
			# Preserve integer keys, Colors, vectors and nested action/replay data.
			# Objects are never deserialized from a peer.
			message["arg"] = Marshalls.base64_to_variant(message["arg_b64"], false)
			emit_signal("message_received", message)
		_:
			emit_signal("message_received", message)

func get_client():
	return null

func has_client_id() -> bool:
	return client_id != 0

func get_client_id() -> int:
	return client_id

func end_connection():
	closing_cleanup()
	if _is_web:
		if _photon_bridge:
			_photon_bridge.disconnect()
		else:
			emit_signal("connection_ended")
		return
	if _client.get_connection_status() != NetworkedMultiplayerPeer.CONNECTION_DISCONNECTED:
		_client.disconnect_from_host()
	else:
		emit_signal("connection_ended")

func _connected(_protocol: = ""):
	connected = true
	_closing = false
	print("connected to server at " + str(address))
	emit_signal("connection_succeeded")

func _connection_error():
	closing_cleanup()
	emit_signal("connection_failed")

func _closed(_was_clean: = false):
	closing_cleanup()
	emit_signal("connection_ended")

func closing_cleanup():
	connected = false
	client_id = 0
	_closing = true

func _on_data_received():
	_drain_packets()

func _drain_packets():
	var peer = _client.get_peer(1)
	if peer == null:
		return

	while peer.get_available_packet_count() > 0:
		var packet = peer.get_packet()
		if packet.empty():
			continue
		var payload = packet.get_string_from_utf8()
		var message = parse_json(payload)
		if typeof(message) != TYPE_DICTIONARY:
			continue
		if message.has("client_id"):
			client_id = int(message["client_id"])
		emit_signal("message_received", message)

func send_message(message: Dictionary) -> int:
	if not connected:
		return ERR_UNCONFIGURED
	var peer = _client.get_peer(1)
	if peer == null:
		return ERR_CONNECTION_ERROR
	return peer.put_packet(to_json(message).to_utf8())

func create_match(player_name: String, public_match: = true, version = null) -> int:
	if _is_web:
		if not _photon_bridge:
			return ERR_UNCONFIGURED
		_photon_bridge.createMatch(player_name, public_match, to_json(version))
		return OK
	return send_message({
		"type": "create_match",
		"player_name": player_name,
		"public": public_match,
		"version": version,
	})

func join_match(player_name: String, room_code: String, version = null) -> int:
	if _is_web:
		if not _photon_bridge:
			return ERR_UNCONFIGURED
		_photon_bridge.joinMatch(player_name, room_code, to_json(version))
		return OK
	return send_message({
		"type": "player_join_game",
		"player_name": player_name,
		"room_code": room_code,
		"version": version,
	})

func request_match_list() -> int:
	if _is_web:
		if not _photon_bridge:
			return ERR_UNCONFIGURED
		_photon_bridge.requestMatchList()
		return OK
	return send_message({"type": "fetch_match_list"})

func request_player_count() -> int:
	if _is_web:
		if not _photon_bridge:
			return ERR_UNCONFIGURED
		_photon_bridge.requestPlayerCount()
		return OK
	return send_message({"type": "fetch_player_count"})

func send_relay_rpc(function_name: String, arg = null) -> int:
	if _is_web:
		if not _photon_bridge:
			return ERR_UNCONFIGURED
		_photon_bridge.sendRelayRpc(function_name, Marshalls.variant_to_base64(arg, false))
		return OK
	return send_message({
		"type": "relay_rpc",
		"function_name": function_name,
		"arg": arg,
	})

func poll():
	if _is_web:
		if _photon_bridge:
			_photon_bridge.service()
		return
	_client.poll()
	_drain_packets()
