# Static model import

Design rationale: [import artist formats during development](adr/0014-import-model-formats-during-development.md).

The contributor import tool converts a bounded glTF 2.0 JSON or GLB asset into one normalized
model plus readable Luau and Odin modules. Games use existing typed textures,
materials and immutable textured meshes. No glTF parser runs in the cartridge,
no runtime ABI changes, and CPU rendering remains the default.

This importer is currently a contributor command; ordinary standalone creation,
building and playback do not require it. From the Bytorio source checkout:

```text
mise run byt -- import <asset.glb> --output <game>/src/imported
```

The generated directory contains `model.json`, `model.luau` and `model.odin`.
Odin package names derive from model content so different imported assets can
coexist. Luau uses compact numeric vertex rows and RGBA words, expanding typed
vertices once during creation; this avoids repeated record keys and byte entries
in the source budget. Draws continue to reuse immutable host resources.

For a solid atlas color, author UVs at the center of a texel. A constant UV on
a texel boundary can round toward either neighboring texel during GPU
perspective interpolation, producing driver-dependent speckling. The racing
asset generator uses explicit texel centers and checks that property on import.
Keep it dedicated to generated files. Both language files may remain there:
each compiler consumes its own language. Reimport after changing the artist asset;
edit the game source to animate or position instances. No external model or image
files are needed by the exported native player, browser player or PNG cartridge.

The import report names the minimum SDK/profile and counts input bytes, upload
bytes, unique vertices/triangles, instance draws and generated source bytes.
Opaque assets require SDK 0.4.0 / `textured-3d-preview-1`; masked assets require
SDK 0.5.0 / `alpha-3d-preview-1`. Set the required `profile` in `bytorio.toml`;
the distribution pin selects an SDK that supports it.
The generated loader checks the SDK before allocating resources.

## Supported artist export

Export one selected scene with static indexed triangle meshes and uniquely named
nodes, such as `body`, `wheel_front_left` and `wheel_front_right`. Mesh geometry
may be shared by several nodes. Keep the rigid node hierarchy; do not export
skeletal or baked animation tracks. Games provide rigid animation themselves.

- POSITION uses float32 VEC3. TEXCOORD_0 uses float32 or normalized unsigned
  byte/short VEC2. COLOR_0 uses float32 or normalized unsigned byte/short VEC3/VEC4;
  vertex alpha must be one. Index accessors use unsigned byte, short or int.
  Valid interleaved attribute strides are supported. Sparse accessors are rejected.
- Nodes accept an affine column-major matrix or translation/unit-quaternion/scale,
  composed as T×R×S. Singular transforms, malformed hierarchies, repeated parents,
  duplicate names and coordinates beyond the runtime bounds are rejected. Unnamed
  nodes receive stable `node_<source index>` names. The selected scene is imported.
- Materials use base color factors and an optional PNG base-color texture on
  TEXCOORD_0. Choose nearest filtering without mipmaps; omitted filters become
  nearest. U/V wrapping supports clamp-to-edge or repeat. Other explicit filtering
  or wrapping modes are rejected. OPAQUE and MASK work; BLEND is deferred.
- Images may use local relative paths, embedded base64 data, or GLB bufferViews.
  PNG supports noninterlaced 8-bit RGB/RGBA, all five row filters, and checked CRCs.
  Palette/gray/interlaced PNG, tRNS transparency, animated PNG and JPEG are rejected.
  Export RGBA8 when transparency is needed.
- Extensions, skins, morphs, embedded cameras, animation tracks, additional UV/color
  sets and normal/occlusion/emissive/metallic-roughness texture maps are rejected
  with diagnostics. NORMAL may be present and is validated, but rendering uses
  the existing flat geometric normals. This is a base-color import path: PBR
  lighting, smooth normals and glTF backface culling are not reproduced. Runtime
  triangles remain two-sided. The CLI report repeats these rendering limits.

The format conventions follow the [Khronos glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).
The importer reflects local Z and converts node matrices with C×M×C, then reverses
triangle winding. This preserves named local frames in the console's +Z-forward
coordinate convention. UVs retain top-left (0,0); image rows are not flipped.

Base-color factors are baked into sRGB texels through linear color conversion.
MASK pixels are premultiplied after baking the alpha factor; the cutoff becomes
`ceil(alphaCutoff × 255)`. Alpha is quantized to RGBA8, so values close to a cutoff
may differ from a floating-point glTF renderer. OPAQUE ignores texture alpha.
Vertex colors become linear byte tint weights, multiplied by encoded texel RGB
under the existing renderer contract; this approximates linear-space glTF tinting.
Normals and material lighting follow the console's flat-lighting model.

## Use and animate a model

Luau, with the generated module at `src/imported/model.luau`:

```luau
local byt = require("@bytorio")
local model = require("./imported/model")
local instance = model.create() -- in init/update
local locals = model.local_transforms()
local base = model.local_transforms()
local wheel = model.index("wheel_front_left")

-- In update: rotate around the named part's own local pivot.
locals[wheel] = byt.gfx3d.multiply(base[wheel], byt.gfx3d.pose(0, 0, 0, steering, 1))
-- In draw, after binding camera and depth:
model.draw(pass, instance, rootTransform, locals)
-- In update, after its final use:
model.destroy(instance)
```

Odin imports the generated directory with `import model "./imported"`:

```odin
instance := model.create()
locals := model.local_transforms()
base := model.local_transforms()
wheel := model.index("wheel_front_left")
locals[wheel] = g.multiply(base[wheel], g.pose(0, 0, 0, steering, 1))
model.draw(pass, &instance, root = root_transform, locals = locals[:])
model.destroy(&instance)
```

Use these statements in the corresponding lifecycle callbacks, with persistent
instance/transform state. Node indices follow each language's ordinary indexing:
Luau starts at one, Odin at zero. `local_transforms` returns independent copies;
omitting overrides uses the imported bind pose. Overrides replace local matrices,
and parents are recomposed before children each draw. Create resources once;
changing transforms does not rebuild geometry or textures. Instancing one source
mesh inside the imported hierarchy shares its resource. Separate calls to `create`
own separate resources. `destroy` releases meshes, then materials, then textures,
and is idempotent. Never draw a destroyed instance. The normal phase and atomic
resource-commit rules still apply.

## Bounds and publication

This first source-based importer deliberately targets small assets. It accepts
at most 8 MiB of accounted source/decoded URI input, 128 selected/source nodes,
128 unique primitives, 64 materials and 256 draws per instance. Aggregate init
upload storage is limited to 512 KiB, and each generated language module to
128 KiB, leaving room for the SDK and game in the current Luau bundle. Existing
runtime vertex/index, image-axis, resource, command and PNG cartridge limits still
apply. Large indexed asset delivery remains a separate packaging feature.

External files must stay inside the source asset's directory after realpath
resolution. Network/absolute URIs and traversal or symlink paths that escape this
directory are rejected.
All parsing, bounds checking and source formatting complete before publication.
Replacing a recognized generated directory uses sibling staging and backup
directories; a failed replacement restores the previous result. A directory
containing extra or unrecognized files is preserved and refused. If filesystem
failure also prevents rollback, the diagnostic identifies the retained backup.
There is a brief rename interval during replacement; it is not a concurrent-reader
or power-loss durability guarantee.

## Reproduce the examples

The checked-in fixture is original diagnostic box and wheel-panel geometry with
an interleaved color/UV stream, hierarchy and a small RGBA texture. It exercises
material conversion and rigid transforms rather than providing finished vehicle art.
The [Luau](../examples/models/luau/main.luau) and
[Odin](../examples/models/odin/main.odin) games use the generated modules:

```text
mise run //examples/models:build
mise run //examples/models:serve
mise run validate test:models
mise run validate test:models:gpu
```

The gallery links both players. Left/right animate body/wheel transforms; holding
Down releases resources and releasing it recreates them. Action selects 640×360.
CPU conformance requires exact SDK/host output, independently expected import
data, malformed-input checks and reproducible/failure-safe publication. The optional
GPU check exercises the same packaged models, transforms and lifecycle on both
hosts, with streamed and resident meshes. Both suites also exercise an opaque-only
version under SDK 0.4.0. Checked generated modules alongside the examples are
compared with a fresh import; use `mise run //examples/models:generate` to update them after
an intentional fixture or generator change.
