# Two Lane

Two-player co-op rally that runs in the browser. One player drives and the other navigates. Only the navigator has the
map, so you have to talk. Proximity voice is built in, and your partner's voice comes from their seat.

## Run it

```
npm install
npm start          # http://localhost:3210  (PORT=xxxx to change)
```

Open the page, join a room, and send your partner the invite link. Pick seats, a stage and what the driver can see, then
press **Start stage**.

To play over the internet, the page must be served over **HTTPS**, because browsers only allow the mic on secure pages. A
quick option is `cloudflared tunnel --url http://localhost:3210`. Voice is peer-to-peer. On some strict networks it needs
a TURN server; add one to `ICE_SERVERS` in `public/voice.js`.

## Controls

| Driver | Navigator |
|---|---|
| W / S: throttle, brake / reverse | Space or hold right-click: raise / lower the map |
| A / D: steer | Scroll: zoom the map |
| E / Q: shift up / down (Q below 1st = neutral, then reverse) | |
| Space: handbrake | Mouse: look around |
| R: reset to last checkpoint (+5 s) | M: mute mic |
| Mouse: look around · M: mute mic | Esc: pause (both players) |
| Esc: pause (both players) | |

A gamepad also works for the driver: triggers for throttle and brake, left stick to steer, A for the handbrake, bumpers to shift.
The pause menu has Resume, Restart stage, Quit to lobby, mouse sensitivity and Manual/Automatic gearbox.

## How a stage works

- There are 23 stages across seven terrains: Alpine, Desert, Forest, Snow, Coast, Highland moor and Outback. Surfaces
  are tarmac, gravel or snow. Five of them are **hill climbs** (Summit Run, Crater Road, Frozen Ascent, Cliffside Climb,
  Ben Crag Climb): short, hairpin-heavy, and climbing 180–300 m from start to finish.
- Each stage is a narrow rally road full of hairpins, square 90s, esses and crests you can jump, with forks along the way. The navigator's map shows the correct route in **green** and
  wrong turns in **red**.
- Wrong turns end at a **ROAD CLOSED** barrier or, on Alpine and Desert, at a **cliff**. Going over the edge or into the
  river resets you to the last checkpoint with a +5 s penalty.
- Driver visibility options: **Clear**, **Fog** (~50 m), **Night** (headlights only), **Blindfold** (the driver's screen
  is black).

## Project layout

| File | What it does |
|---|---|
| `server.js` | Static files + WebSocket rooms (lobby → race → results), relays car state and voice signaling |
| `public/maps.js` | All stages: seed, theme, route style, guide waypoints, grip, climb, river/sea, colours |
| `public/stage.js` | Rally stage generator: builds the route from hairpins, square 90s, esses and straights; adds wrong turns and jumps |
| `public/terrain.js` | Generates terrain, roads, bridges, props and colliders from a map (pure JS; also runs in Node) |
| `public/physics.js` | Arcade car physics on the heightfield (runs on the driver's machine only) |
| `public/world.js` | Turns the generated world into three.js meshes |
| `public/car.js` | Built-in car with interior, plus the custom-model loader |
| `public/character.js` | Low-poly seated characters with arm IK (hands on the wheel or the map) |
| `public/mapview.js` | The navigator's paper map (canvas texture) |
| `public/main.js` | Game flow, first-person camera, input, networking |
| `public/voice.js`, `public/audio.js` | WebRTC voice, 3D audio, engine sound |

**Editing a stage:** stages are generated from `public/maps.js`. Change a map's `seed` to get a completely different stage
on the same theme. Its `guide` points set the rough path across the map. Piece mix, length, number of forks and jumps live in
`STYLES` in `public/stage.js` (alpine, desert, forest, hillclimb, flowing, technical, coast). A map picks one with `style`
and can override single fields with `tweak`. Set `climb: <meters>` to make any stage a hill climb. New terrains are
added in `THEMES`/`PROP_RULES` (terrain.js), `PALETTE`/`ROCK_COLOR` (world.js) and `TINTS` (mapview.js). Both players generate the same stage from the seed, so nothing is downloaded.

## Using your own car model

Export your car from Blender as **glTF Binary** and save it as `public/models/car.glb`. The game loads it automatically and
hides the built-in shell. If the file is missing or fails to load, it falls back to the built-in car.

Conventions (in Blender):

- **Units:** meters. **Origin:** on the ground, centered between the four wheels.
- **Front of the car points toward −Y.** The exporter's default "+Y Up" setting turns that into the game's forward. With
  this orientation, the car's left side (driver side) is **+X**.
- Optional named objects the game animates:

| Object name | Purpose |
|---|---|
| `Wheel_FL`, `Wheel_FR`, `Wheel_RL`, `Wheel_RR` | Spin; front ones also steer. Origin at the wheel center, rotation applied (axle along X). |
| `SteeringWheel` | Turns with steering. Origin at the hub; it spins around its local Y axis (the column axis). The driver's hands grip it 17 cm left/right of the hub. |
| `Seat_Driver`, `Seat_Passenger` | Empties placed where each player's **eyes** should be. The characters and cameras are positioned from these. |

Any of these can be left out; the built-in wheel or steering wheel is then used for that part. Remember to model the
interior: dashboard, seats, door insides, and a roof you can see from below. Players only ever see the car from inside.

## Dev shortcuts

These URL parameters exist for testing: `?autojoin` (join without mic), `&role=passenger`, `&map=desert`, `&vis=night`,
`&autostart`, `&at=300` (start at road sample 300), `&yaw=0.9` (initial head turn).
