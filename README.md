# Arm Simulator

A browser-based robot arm visualiser. Feed it joint states — from a live robot,
a script, or a recorded file — and it animates the arm in 3D. Built around a
robot registry so adding a new arm is a single definition file plus its URDF.

The first supported arm is the **LeRobot SO-101**.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

The app opens with the **Manual** source selected, so you can drag the joint
sliders straight away. To see a live stream, run the demo publisher in a second
terminal:

```bash
npm run demo         # serves ws://localhost:8765
```

then choose **WebSocket** in the sidebar and connect.

> **Robot meshes are not bundled.** Until you add them, the app renders a
> schematic placeholder arm that still responds to every input. See
> [`public/robots/README.md`](public/robots/README.md) for where to get the
> SO-101 URDF and where to put it. Nothing else needs to change.

## Feeding it joint states

Three input sources, chosen in the sidebar:

| Source | Use it for |
| --- | --- |
| Manual | Dragging sliders by hand |
| WebSocket | A live robot or control loop |
| Playback | Replaying a recorded `.jsonl` / `.json` trajectory |

### WebSocket

Send one JSON message per frame. The simulator reconnects on its own if the
producer restarts. All of these are understood:

```jsonc
// Native format, the most explicit
{ "unit": "rad", "timestamp": 1717171717.5, "positions": { "shoulder_pan": 0.4, "gripper": 0.8 } }

// Bare joint map
{ "shoulder_pan": 0.4, "shoulder_lift": -0.2, "gripper": 0.8 }

// Ordered array, matching the definition's joint order
[0.4, -0.2, 0.7, 0.0, 1.1, 0.8]

// ROS sensor_msgs/JointState
{ "name": ["shoulder_pan", "elbow_flex"], "position": [0.4, 0.7] }

// LeRobot feature keys
{ "observation.state": [0.4, -0.2, 0.7, 0.0, 1.1, 0.8] }
```

`unit` may be `rad`, `deg`, or `norm100` for LeRobot's normalised -100..100
range. Values outside a joint's limits are clamped, and unrecognised keys are
reported in the Activity panel rather than silently ignored.

A frame that omits `unit` falls back to the robot definition's `streamUnit`,
which is `deg` for the SO-101 and SO-100 because LeRobot's `use_degrees` has
defaulted to true since v0.6.0. Send `unit` explicitly and this never matters.

One LeRobot quirk is handled for you: the gripper is always reported on a 0..100
scale even when the arm joints are in degrees. The SO-101 definition maps that
single joint accordingly, so a mixed-unit frame comes out right without any work
on the producer side.

### Bridge

Producers that would rather POST than host a socket can use the relay:

```bash
npm run bridge                              # ws + http on port 8765
python examples/python/send_joint_states.py # standard library only
```

`POST /joint_states` with a JSON frame; every WebSocket subscriber receives it.
`GET /health` reports subscriber count and frames relayed.

To mirror a physical arm, [`examples/python/from_lerobot.py`](examples/python/from_lerobot.py)
reads a connected SO-101 follower and forwards its observations.

### Playback

Load a `.jsonl` file (one JSON frame per line) or a JSON array of frames. Frames
carrying a `timestamp` play at their recorded pace; otherwise a fixed 30 fps is
assumed. **Load sample** plays a bundled 20-second clip.

## Adding another arm

1. Create `src/robots/definitions/<id>.ts` exporting a `RobotDefinition`: the
   URDF path, the joint list with the stream keys your producer sends, and the
   camera framing.
2. Register it in `src/robots/registry.ts`.
3. Drop the URDF and meshes under `public/robots/<id>/`.

Joint limits are read from the URDF at load time and override the fallbacks in
the definition. Optionally add a `placeholder` chain so the arm has a stand-in
model before its meshes are installed.

## Driving the arm from a pose capture

The playback panel also accepts a MediaPipe Pose export: one record per video
frame, with flat `<landmark>_x/_y/_z/_visibility` keys. It is recognised on load
and retargeted to the arm, so no conversion step is needed.

Only the shoulders, hips, and one arm's shoulder, elbow and wrist are read. From
those, three angles are derived and mapped to `shoulder_pan`, `shoulder_lift` and
`elbow_flex`. Wrist flex, wrist roll and the gripper stay under manual control,
because a capture without hand landmarks carries no information about them.

Which arm to follow is a toggle in the panel. `Auto` picks whichever arm the
detector tracked in more frames, which is usually the right choice when the
subject is turned to one side; the percentage beside each option is the share of
frames that arm is usable in. Left and right are the subject's own, as the
detector labels them, so in a front-facing video the left arm appears on the
right of the screen.

Angles are measured in a frame built from the body itself — the torso axis and
the shoulder line — rather than from image axes. A subject who is reclining, or a
camera that is rotated, therefore produces the same result as an upright one.

Real captures need more than the geometry, and three properties drive the rest of
the design:

- **Dropped frames.** Frames where the detector found nobody are written as the
  string `"nan"`. Every read is checked, because `NaN` silently passes
  comparisons like `value < threshold`. Unusable frames are omitted, so playback
  holds the last good pose over a gap rather than inventing motion.
- **The overhead singularity.** When the upper arm points along the torso, its
  heading around that axis is undefined and noise makes the computed azimuth
  flip. Near that pole the previous heading is held, and the heading is tracked
  unwrapped so that crossing +/-180 degrees does not read as a sweep across the
  joint's whole travel.
- **Landmark jitter.** Elbow and wrist confidence is much lower than the
  shoulders'. Angles are damped and then rate-limited, which also keeps the
  output within something a real arm could follow.

Two mapping modes are offered. Both centre the captured motion on the joint's
mid-travel and differ only in gain: **fill joint range** stretches the observed
range to fill the travel, which keeps a subject who barely moved visible, while
**keep captured scale** transfers the human's angular scale one-to-one. Fill mode
will not amplify by more than 1.5x, since stretching a narrow, noisy range would
turn jitter into violent motion.

To inspect a capture before loading it:

```bash
npm run inspect:pose -- capture.json     # visibility, dropouts, angle ranges
npm run verify:retarget -- capture.json  # limits, travel used, per-frame steps
```

## Safety checks

Incoming commands are clamped to each joint's URDF limits, and the affected
sliders are flagged in the sidebar so a producer sending out-of-range values is
visible rather than silently corrected.

The Safety panel adds two collision checks, both driven by a bounding volume
hierarchy per mesh (`three-mesh-bvh`):

- **Self-collision** between links that are not directly connected by a joint.
- **Mounting-surface contact**, treating everything below the grid as solid, so
  the arm reaching under its own table is reported. A 2 mm tolerance keeps the
  base, which sits exactly on the surface, from firing constantly.

Which link pairs are worth testing is decided once at load. Directly connected
links are skipped, since they touch at their shared joint by construction. Any
other pair is skipped only if its meshes overlap in *every* sampled pose — the
signature of a motor horn seated inside its bracket, which would otherwise
report contact forever. Sampling several poses rather than only the zero pose
matters: on a folded arm the zero pose is a poor judge of permanent overlap, and
judging from it alone can quietly retire the base-versus-arm pairs. The pairs
that survive are listed in the activity log at load time.

"Block motion on contact" holds the last collision-free pose instead of letting
the arm pass through itself or the surface. Detection alone leaves motion
untouched and only reports and highlights the contact.

Run `node scripts/verify-links.mjs` to audit the selection headlessly; it prints
the tested pairs, anything retired, and which poses trigger each overlap.

## Project layout

```
src/
  robots/       Robot definitions and the registry (the multi-arm surface)
    definitions/  so101.ts, so100.ts
  io/           Joint-state ingestion: payload parsing, WebSocket, playback,
                and pose-capture retargeting
  scene/        three.js rendering, URDF + mesh loading, placeholder arm
  state/        Zustand store, plus the joint bus that bypasses React
  ui/           Sidebar panels, status bar, overlays
  hooks/        Sampling and stream lifecycle hooks
server/         Demo publisher and the HTTP-to-WebSocket bridge
examples/python/  Producer scripts
public/robots/  URDFs and meshes (you supply these)
```

### Why joint values bypass React state

Streams can run well above 60 Hz. Routing every frame through React would
re-render the tree each time, so incoming positions land in a plain object
(`src/state/jointBus.ts`) that the renderer reads inside its animation loop.
The sidebar samples the same object on a timer. React state holds only
configuration and connection status.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Typecheck and production build |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | Types only |
| `npm run demo` | Standalone WebSocket demo stream |
| `npm run bridge` | HTTP-to-WebSocket relay |
| `npm run check:assets` | Verify a robot's URDF and mesh references resolve |
| `npm run inspect:pose -- <file>` | Summarise a pose capture's quality |
| `npm run verify:retarget -- <file>` | Check retargeted output is usable |
| `node scripts/verify-links.mjs` | Audit collision pair selection |
| `node scripts/verify-collision.mjs` | Unit-test the collision math |

## Requirements

Node 20.19+ or 22.12+ (required by Vite 8).

## Stack

React 19, TypeScript, Vite 8, three.js with `@react-three/fiber` and `drei`,
`urdf-loader` for URDF parsing, Zustand for UI state.
