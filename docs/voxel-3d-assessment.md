# Voxel resources and compact 3D

Status: original design assessment. The subsequent
[experimental implementation](compact-3d.md) establishes the mesh/camera/depth
foundation and a bounded voxel prototype. Chunked/merged surfaces remain proposed;
the implementation document and measurements describe the actual supported scope.

## Recommendation

Support voxel models as another typed resource feeding the shared 3D renderer.
Keep indexed meshes, cameras, depth testing and explicit target passes as the
foundation. Small voxel characters, props and editable rooms fit that design;
large streamed worlds and a complete voxel simulation engine require more work.

The output remains 320×180 or 640×360. A model's voxel dimensions describe asset
data, independently of the screen resolution. Orthographic cameras can present
compact dioramas; perspective cameras can support other game styles. Ordinary
meshes and voxel surfaces should share depth, lighting/fog and 2D composition.

A whole-scene volumetric framebuffer is a different rendering contract: every
object is first sampled into a shared 3D grid before projection. That could be
explored later if games need that particular visual behavior. It is not required
to render voxel assets, and should not constrain the general 3D pipeline.

## Resource and SDK design

The following names describe candidate concepts, not frozen SDK signatures:

- `VoxelVolume`: bounded dimensions, cell format, palette association and origin.
  Begin with opaque indexed cells, reserving one index for empty space. Define
  occupancy independently of palette alpha so changing a color cannot silently
  change geometry or collision semantics.
- Region operations: bulk upload, fill and copy with explicit bounds and strides.
  Local per-cell SDK helpers edit a staging buffer, followed by a bulk submission.
  Avoid a host transition or draw command per voxel.
- Shared 3D passes: draw a volume with an instance transform and voxel scale using
  the same camera, depth attachment and lighting controls as an indexed mesh.
  Multiple instances share one resource and its cached surface geometry.

Both SDKs should use the same resource protocol and Odin host implementation.
Luau buffers and Odin slices provide equivalent staging paths; neither receives
host pointers. Preserve the existing checked handles, session isolation, bounded
packets, validation and failure reporting.

Volume edits and derived geometry must become visible together at a defined
commit boundary. If rebuilding exceeds a permitted work budget, reject the edit
without changing the previous version, or expose an explicitly asynchronous
operation with completion before use. Do not let background task timing silently
change which version a draw observes. Retained versions used by accepted work
remain charged until released.

## Host rendering strategy

Start with host-generated visible-face meshes cached until their source changes.
Cull interior faces and investigate merging compatible coplanar faces. This is a
standard surface extraction approach with a tradeoff between mesh size and
rebuild time; see the [meshing analysis](https://0fps.net/2012/06/30/meshing-in-a-minecraft-game/).
This proposal requires an original implementation.

For editable scenes, evaluate small chunks such as 16³ and 32³ as prototype
candidates. Boundary edits invalidate neighboring chunks where visibility changes.
Palette indices can remain in generated geometry so color-only palette edits do
not require remeshing. Bound cells processed, dirty chunks and generated geometry
separately: volume dimensions alone do not bound rendering cost adequately.

The implemented host currently renders a software framebuffer. GPU acceleration
is a future backend decision, not an existing capability. Establish correctness
and measure the software path before promising a frame rate or deciding that it
can handle the intended voxel workload.

Start animation with frame sequences of shared voxel resources and rigid instance
transforms. Rotating a generated mesh preserves its cube geometry; resampling a
rotating model into a display grid would produce different visual behavior.
Neither skeletal animation nor per-frame whole-volume reconstruction is required
for the first experiment.

## Memory and packaging constraints

The published [resource profile](resource-profile.md) and
[machine-readable limits](../sdk/profiles/resource-av-1.json) define the resource budgets.
They currently allow 8 MiB Odin guest memory, a 4 MiB Luau heap, a 64 MiB resource
budget and 1 MiB payload per commit. Luau's separate executor-memory ceiling is
64 MiB to accommodate source and compilation. The fixed audio/control reservation is
55,463,952 bytes when that path is activated, leaving 11,644,912 bytes (about
11.1 MiB) of resource headroom before other allocations.

Illustrative raw storage, assuming one byte per voxel:

| Dimensions | Cell storage |
| --- | ---: |
| 32³ | 32 KiB |
| 64³ | 256 KiB |
| 128×128×64 | 1 MiB |
| 128³ | 2 MiB |
| 256³ | 16 MiB |

These figures exclude palettes, geometry, scratch space, uploads, pending and
retired versions. A proposed RGBA8 target plus 32-bit depth would additionally
need 460,800 bytes at 320×180 or 1,843,200 bytes at 640×360, before overhead.
Source grids and cached geometry must both be accounted for. Host ownership
avoids keeping all assets in guest memory, but guest staging still consumes the
guest's allocation.

Surface complexity is a separate risk. A 16³ checkerboard with 2,048 isolated
occupied cells has 12,288 exposed cube faces, or 24,576 triangles before any
additional rendering work. Dense solid models can be far cheaper despite
containing more occupied cells.

Current PNG cartridges allow a 10 MiB cover/code envelope, including an 8 MiB
Wasm module, plus separately indexed content up to 512 MiB.
Small models can embed data with their code; larger asset sets can use bounded
indexed-content reads. Compressed cartridge size does not establish a safe
decoded resource size.

Any supported 3D extension needs an explicit profile/feature negotiation decision
and measured budgets. Do not silently expand or reinterpret the published
`resource-av-1` contract to accommodate voxels.

## Rendering versus gameplay

Occupancy data could later support bounded cell and ray queries. Actor ownership,
movement, collision response, destruction rules, debris and persistent world
state remain gameplay or higher-level library concerns. A voxel renderer alone
does not supply those systems. Keep general physics, advanced shadows and complex
animation outside the first 3D milestone as already planned.

External asset conversion should produce our own versioned resource data rather
than couple runtime semantics to an editor's file format. A scene editor is not
a prerequisite for proving the renderer and SDK transport.

## Prototype gate before accepting limits

After establishing the mesh/camera/depth foundation, use one equivalent Luau and
Odin scene through the same native and browser player:

1. Render a small voxel room, animated character, rotating prop, ordinary mesh
   and 2D HUD. Verify shared occlusion and composition at both display modes.
2. Edit a wall, including chunk-boundary edits; exercise palette changes, repeated
   instances and resource replacement/release. Check rejected edits preserve the
   prior resource and session reload invalidates old handles.
3. Include solid, checkerboard and multicolored surfaces, many dirty chunks and
   allocation exhaustion. Verify decoded-size and generated-geometry limits.
4. Measure cold/warm startup, p50/p95 frame cost, remesh latency, cells/chunks
   processed, faces/triangles, command and transfer bytes, and peak memory split
   into source, geometry, scratch and retained versions. Repeat with audio active.
5. Compare the two SDKs and both hosts for equivalent behavior, with image checks
   under an explicit rasterization tolerance. Qualify target devices before
   claiming a frame budget.

Use these results to decide chunk sizes, geometry caps, edit budgets, profile
memory and whether a GPU backend is necessary. The subsequent
[prototype measurements](internal/measurements/compact-3d-measurements.md) provide initial evidence;
minimum-device qualification and published voxel limits remain future work.
