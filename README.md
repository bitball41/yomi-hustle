# YOMI Hustle web export

Serve this entire directory, including `multiplayer/`, over HTTP(S) and open
`index.html`. Hosted checkouts use sibling assets. Standalone file/blob launchers
and `/file` links use this fork's assets on jsDelivr, so the multiplayer fixes are
loaded instead of another repository's export.

## Multiplayer

The built-in multiplayer menu connects to Photon Realtime in the US region.
Enter a name, host a room, and share its six-character code. The host can start
once both players appear. Public rooms also appear in the lobby list.

This build uses Photon application version `1.1` to keep its corrected wire
format separate from older broken clients. Both players need the same build.

The multiplayer fixes preserve Godot Variants using base64-encoded binary
serialization. Arrays, integer dictionary keys, Colors, vectors, action data,
and replay data survive the Godot → JavaScript → Photon → Godot round trip.
Object deserialization is disabled. Version metadata crosses JavaScript as JSON.

Connection attempts have a timeout and alternate secure endpoints. Old clients
are detached before disconnecting so synchronous Photon callbacks cannot consume
the next retry. Notifications are drained by the game's poll after its signal
listeners are ready. Failed room operations restore the lobby's Reconnect control.

## Rebuilding

The game was supplied as a compiled Godot 3.5.1 export. Its edited multiplayer
sources live in `multiplayer/`; `photon-bridge.js` is embedded into
`WebsocketClient.gd` during the build.

Download [GDRE Tools 2.6.4](https://github.com/GDRETools/gdsdecomp/releases/tag/v2.6.4), then run:

```sh
python3 tools/build_multiplayer.py --gdre /path/to/gdre_tools.x86_64
node --test tests/*.test.cjs
```

The builder creates `multiplayer/patch.pck` with only three edited bytecode
resources and checks the source pack's MD5s. The launcher combines this small
patch with `index.pck` before Godot starts. Other game resources and the engine
WASM do not need re-exporting.

For a gameplay smoke test, use two browser sessions: join an invalid code and
reconnect, host a private room, join by code, start, select both characters,
submit turns, and leave/reconnect. Both clients should advance to the same tick.
