# Robot assets

Drop each robot's URDF and meshes here. Everything under `public/` is served at
the site root, so `public/robots/so101/so101_new_calib.urdf` is fetched as
`/robots/so101/so101_new_calib.urdf` — which is exactly the `urdfUrl` recorded
in the robot's definition file.

```
public/robots/
  so101/
    so101_new_calib.urdf
    assets/
      base_so101_v2.stl
      ... 13 STL files in total
  so100/
    so100.urdf
    assets/
```

The app runs without these files: any robot whose URDF is missing falls back to
a schematic placeholder arm that still responds to live joint states, so the
input pipeline can be tested before the assets arrive. The on-screen panel
distinguishes a missing file from an empty one from a malformed one.

## Getting the SO-101 files

Source: [TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100),
Apache-2.0. The files live under `Simulation/SO101/`.

Copy `Simulation/SO101/so101_new_calib.urdf` and the entire
`Simulation/SO101/assets/` folder into `public/robots/so101/`.

**Use `so101_new_calib.urdf`, not `so101_old_calib.urdf`.** The new file zeroes
each joint at the middle of its range, which is what LeRobot's calibration
produces. The old one zeroes at the fully-extended horizontal pose and has
substantially different `shoulder_lift`, `elbow_flex` and `wrist_roll` limits.

A few practical notes:

- The meshes total roughly **16 MB** across 13 STL files, with the largest at
  2.7 MB. Serve them compressed, or convert to a single Draco-compressed glTF,
  if first load matters. `sts3215_03a_v1.stl` is referenced five times but is
  fetched only once thanks to the loader's cache.
- The URDF references meshes as `assets/<name>.stl`, **relative to the URDF
  itself**, so `urdf-loader` resolves them with no extra configuration. This is
  why the folder must be named `assets/`.
- Do not use the `so101.urdf` from the bambot project. It is an older
  derivation with different joint names (`Rotation`, `Pitch`, `Elbow`, `Jaw`)
  and limits offset by about π. Combined with LeRobot-style stream keys,
  nothing would move and it would look like a streaming fault.

If you would rather not vendor the files, jsDelivr serves the repo directly and
you can point `urdfUrl` at it. Pin a commit or tag rather than `@main`:

```
https://cdn.jsdelivr.net/gh/TheRobotStudio/SO-ARM100@main/Simulation/SO101/so101_new_calib.urdf
```

## Mesh path resolution

Relative paths like `assets/base_so101_v2.stl` work out of the box.

If a URDF instead uses ROS package URIs such as
`package://so101_description/meshes/base_link.stl`, map the package name to a
URL in the robot's definition:

```ts
packages: { so101_description: '/robots/so101' },
```

STL, Collada, OBJ and glTF meshes are all supported.

## Adjusting a definition

Definitions live in `src/robots/definitions/`. After adding assets you may need
to change:

- `urdfUrl` — if your filename differs from the default.
- `scale` — set to `0.001` if the meshes are authored in millimetres.
- `upAxis` — almost always `Z` for URDF; switch to `Y` if the model lies on its side.
- `camera` — framing for the arm's size.
- `invert` on a joint — if one rotates the wrong way. LeRobot calibration has a
  per-motor `drive_mode` that can oppose the URDF's axis direction, so check
  each joint individually the first time you connect real hardware.

Joint limits are read from the URDF automatically and override the fallbacks in
the definition, so those rarely need editing.
