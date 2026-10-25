# Riverside viewer and console pipeline comparison

This investigation is a snapshot taken before the resident-mesh implementation.
It compares the independent JavaScript/WebGL viewer with the
shared Odin console renderer. The retained measurements describe the streamed
GPU console backend before the in-progress resident-mesh and GPU-presentation
changes. The implementation and later qualification are described in
[the graphics specification](../../../docs/compact-3d.md) and
[the console measurement report](riverside-console-measurements.md).

## Finding

Both implementations provide supersampling, smooth camera panning and 1080p
expansion. Those features are not missing from the viewer. The difference is
where and how their implementations do the work. A Wasm CPU loop does not become
equivalent to a GPU shader because both produce the same display feature.

The measurements identify different rendering pipelines, rather than equivalent
JavaScript and Wasm implementations with different execution speeds. The viewer
keeps geometry, transforms and final presentation on the GPU. The measured
console pipeline performs substantial CPU geometry processing, synchronous
attachment readbacks and CPU construction of the enlarged presentation image.

Both console SDKs share this renderer. Their update costs were approximately
0.1 ms native and 0.2 ms browser, while browser total p95 was 70.60–74.10 ms.
The rendering pipeline dominates the measured difference between the viewer and
console; cartridge language accounts for little of the observed total.
See [the console measurements](riverside-console-measurements.md) for hardware,
sample counts, stage definitions, correctness checks and exclusions.

| Work                | Independent viewer                   | Measured console pipeline                                               |
| ------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Geometry            | 343,716 triangles, uploaded once     | 33,806 merged triangles, processed and staged each frame                |
| Transforms          | GPU, with small camera/actor updates | CPU model/view transforms per triangle corner                           |
| Lighting            | Baked colors and a simple GPU shader | CPU normals and lighting, including fully ambient fixture draws         |
| Clipping            | GPU                                  | GPU plus CPU clipping and projected-bounds work accounting              |
| Geometry transfer   | Resident buffers and uniforms        | 2,839,704 staged vertex bytes per full-scene frame                      |
| Attachment handling | GPU targets                          | Logical color/depth upload and synchronous readback per raster batch    |
| Final presentation  | GPU shader                           | CPU expansion/composition to 1920×1080 and an 8,294,400-byte extraction |

## Confirmed costs

The [CPU presenter](../../../runtime/odin/presentation/presentation.odin) visits all
2,073,600 output pixels when constructing a 1080p smooth presentation. That loop
calculates source coordinates, reads the HUD mask and composes colors. Browser
raster/composition/presentation p95 reached approximately 43.8 ms. This stage
contains multiple operations, so that measurement does not isolate the presenter
alone. Moving final presentation onto the GPU removes the enlarged CPU loop and
its explicit pixel extraction.

The [streamed mesh path](../../../runtime/odin/resources/mesh.odin) transforms 101,418
triangle corners through model and view matrices for this scene. It computes
face normals and lighting, serializes transformed vertices, clips triangles and
calculates projected bounds for resource work accounting. Its measured draw
commit stage includes that CPU processing and GPU synchronization; approximately
29 ms browser p95 is not a GPU-only timing.

The [browser GPU backend](../../../runtime/odin/web/gpu.js) uploads existing logical
color and depth, initializes supersampled attachments, draws geometry, resolves
color/depth, reads both logical results back and copies them into Wasm memory.
Readbacks use logical dimensions plus overscan, rather than the full 1080p
presentation dimensions. They nevertheless synchronize CPU and GPU execution.
Current CPU composition and transactional attachment ownership consume these
results. Removing them requires preserving rollback and synchronizing actual CPU
consumers explicitly.

The viewer and console also use different resolve work. The viewer can average
linear color. The console resolves color alongside packed depth, with color
conversion and nearest-depth selection. Both console display modes use roughly
2.1 million internal supersampled pixels with the measured settings, so lowering
logical resolution alone saves little.

The [worker](../../../runtime/odin/web/worker.js) explicitly copies presentation pixels
out of Wasm with `.slice()`. Its subsequent transferable `postMessage` hands over
buffer ownership; that handoff is not a second full structured-clone copy.
Main-thread canvas delivery, compositor work and scanout are excluded from the
retained console benchmark.

The worker also renders and extracts presentation for each of up to five catch-up
updates, then sends only the last frame. Final display extraction could occur
once after catch-up while preserving update/draw semantics. Any intermediate
ImageBitmaps produced by a GPU presenter must be closed when discarded.

## What residency changes, and what remains

The in-progress [resident mesh path](../../../runtime/odin/resources/resident_mesh.odin)
removes repeated CPU lighting and transformed-vertex staging. Exact work
accounting still transforms each unique vertex and evaluates clipping and
projected bounds. For these four-vertex quads, this reduces transformed vertices
from 101,418 triangle corners to 67,612 unique vertices; it does not eliminate
CPU geometry work. Residency also introduces approximately 33 mesh draws in
place of one streamed geometry draw, so submission overhead needs measurement.

At inspection time, [raster preparation](../../../runtime/odin/resources/raster_device.odin)
still allocated a 5,505,024-byte legacy staging arena for resident transactions.
The [transaction allocator](../../../runtime/odin/resources/graphics.odin) explicitly
zeroes its allocations. Resident accounting separately allocates and clears
32 bytes per unique vertex. Reducing this scratch work is a concrete candidate,
but its elapsed cost has not been isolated.

GPU presentation and mesh caching are therefore well-targeted changes. They do
not establish 60 fps without new measurements: CPU work accounting, attachment
transfers, readbacks, resolve work and logical composition remain possible
bottlenecks. Keep acceleration and mesh residency explicit opt-ins, with the
existing CPU path available to simpler games and devices.

## Is the scene rebuilt each frame?

The source scene and meshes persist. The renderer repeatedly reconstructs derived
data in the measured backend:

| Lifetime                | Measured streamed backend                                                                         | In-progress resident backend                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Loading                 | `console-game.odin:upload` creates 32 world meshes and one rabbit mesh over 33 updates            | Same resource loading                                                         |
| Steady update           | Retains mesh handles; destroys/recreates the 96-byte camera                                       | Same cartridge behavior                                                       |
| Draw commands           | Submits existing mesh handles and model matrices                                                  | Same commands                                                                 |
| CPU geometry            | Rebuilds 101,418 transformed/lit corners and 2,839,704 upload bytes                               | Recomputes 67,612 transformed positions for accounting; GPU geometry persists |
| GPU vertex storage      | `bufferData(STREAM_DRAW)` replaces the submitted store every frame                                | Cached `STATIC_DRAW` buffers survive until invalidated or evicted             |
| GPU render targets      | High/low attachments persist until dimensions/factor change                                       | Same                                                                          |
| GPU input textures      | Two `texImage2D` calls redefine and upload logical color/depth every raster batch                 | Same; GPU presentation also uploads preview/output/mask                       |
| Transaction attachments | Allocates, zeroes and copies color/depth; clears them for this fixture                            | Same                                                                          |
| Output                  | Reconstructs logical output, copies it to core pixels, builds enlarged CPU output and extracts it | Logical reconstruction remains; GPU presentation replaces enlarged CPU output |

There is no steady-state voxel generation or meshing in this fixture. It uses
ordinary meshes produced by the loading code. The accurate diagnosis is repeated
transformed draw-stream generation and attachment/output reconstruction.

Relevant implementations are the [cartridge lifecycle](../console-game.odin),
[mesh submission](../../../runtime/odin/resources/mesh.odin),
[native backend](../../../runtime/odin/gpu/native/backend.odin), and
[browser backend](../../../runtime/odin/web/gpu.js).
Both GPU backends use texture-image redefinition rather than subimage updates.
This confirms the API calls, not that a particular driver physically allocates
fresh GPU memory each time. Their high/low render attachments are dimension-cached.

## Optimized Wasm evidence

The existing measured browser binary was disassembled without rebuilding it.
Its SHA-256 matches the retained performance report:
`73b133a94f880d3079c508e0ad7ca9edbd7d9c254b5499933ae95688105d0d9b`.
The disassembly and focused function extracts are retained under the ignored
`build/investigation-riverside/` directory:
`runtime-baseline.wat`, `resources__raster_mesh.wat`,
`resources__allocate.wat` and `runtime_presentation.wat`.

This establishes several inefficiencies in the emitted, speed-optimized module:

- `resources::raster_mesh` reserves a 2,448-byte stack frame. Emitted
  `memory.fill` operations clear 168-byte triangle input and 96-byte world
  position arrays, a 728-byte polygon remainder, and an 896-byte next-polygon
  array inside the clipping-plane loop. It also emits the 5,505,024-byte staging
  clear. If every submitted triangle visits all six planes, next-polygon
  clearing alone writes 181,741,056 bytes per frame. This is a conditional work
  estimate, not observed bandwidth; early rejection reduces it.
- `resources::u32le` remains a function with four explicit bounds checks and
  four byte loads/shifts, rather than one packed 32-bit load. The streamed
  per-corner loop reads an index, three positions and a color: 507,090 such
  logical reads for the full scene before additional camera/lighting reads.
  The source does not revalidate every mesh index against vertex count each
  draw, but byte-slice access still carries these checks in emitted Wasm.
- The streamed function contains the square root used for face lighting.
  Its source calculates normals and diffuse intensity despite the fixture's
  `ambient = 1`. The resident shader also expresses normal/diffuse work before
  multiplying by zero for that case; shader-driver elimination is unverified.
- `runtime_presentation` contains calls to `math::modf_f64` for coordinate
  floor operations, including the inner output-pixel calculation, instead of
  a single Wasm floor instruction. It also calls the checked byte decoder for
  preview pixels. This is repeated across the enlarged image.

These are emitted-module observations, not measured contributions to frame time.
The browser compiler can further optimize Wasm. In particular, matrix arguments
being value types in Odin does not establish that each call physically copies a
128-byte matrix: `matrix_point` is inlined in the inspected function. Attribute
only the aggregate clears and operations actually observed, rather than assuming
every source assignment becomes an expensive copy.

The host build already uses `-o:speed` and `freestanding_wasm32`; resource storage
uses Odin's Wasm allocator. Allocator implementation details or the use of f64
alone do not establish a bottleneck. Globally disabling bounds checks, changing
precision or replacing the allocator is not justified by these measurements.

## Ranked optimization candidates

The ordering below is inferred from operation counts and the measured broad
stages. Individual savings have not been profiled.

1. **Stop rebuilding derived geometry and running full clipping unnecessarily.**
   Residency addresses repeated vertex serialization/upload and CPU lighting.
   The streamed path still runs all six clipping passes even for a triangle
   wholly inside the frustum. The resident path adds trivial accept/reject but
   calculates outcodes per triangle corner, then calls the general
   `raster_triangle` for accounting. Cache outcodes and quantized projected
   coordinates alongside each transformed indexed vertex; use exact existing
   clipping only for boundary-crossing triangles. Keep triangle counts and
   quantized bounding-box charges identical. A position-only accounting helper
   can avoid color interpolation, depth lookup, z interpolation preparation and
   winding swaps needed only by the CPU pixel rasterizer. Do not replace exact
   charges with conservative bounds that reject formerly valid packets.

2. **Avoid clearing unused scratch and copying data immediately discarded.**
   Size resident descriptor storage for descriptors instead of retaining the
   5.5 MB streamed arena. Accounting scratch is completely overwritten before
   use; allocate appropriate scratch without unnecessary zeroing while retaining
   budget ownership. `graphics.odin:owned` and `mesh.odin:mesh_owned` currently
   allocate/zero/copy old attachments before the pass clears color and the default
   `gfx3d.bind` clears depth. On these full-clear paths, allocate a separate
   transaction-owned replacement and fill it directly, keeping the original
   attachment untouched for rollback. That avoids copying 460,800 bytes at
   320×180 or 1,843,200 bytes at 640×360 per frame, plus redundant zeroing.
   Do not apply this to partial clears or passes that preserve existing pixels.

3. **Remove the readback/reupload cycle when no CPU operation consumes it.**
   GPU presentation currently receives CPU preview/output/mask data after raster
   readbacks, then uploads it again. Keeping resolved attachments resident can
   avoid this cycle. It requires explicit synchronization for CPU drawing,
   readback requests, hashes and other consumers, plus transaction rollback.
   Full clears also provide an opportunity to initialize GPU attachments with
   clear values instead of uploading CPU-filled buffers and reconstructing them
   with a fullscreen shader. Packed depth attachment contents must remain valid.
   First measure each readback separately from submission and copy-back.

4. **Specialize invariant arithmetic without changing accepted results.**
   Skip face lighting when ambient is exactly one; hoist camera constants out
   of triangle loops. Reuse validated typed mesh data instead of repeatedly
   decoding bytes through four bounds checks, while retaining ingress validation,
   alignment guarantees and resource bounds. Identity-model and orthographic
   fast paths are candidates, but combining matrices or changing f64 to f32 can
   alter rounding and work charges. Compare against the existing arithmetic.

5. **Reduce logical and fallback CPU presentation work.**
   The GPU presenter removes the enlarged CPU loop, but `graphics.odin:present`
   still allocates/zeroes a full logical output and performs byte decoding and
   four-channel `over` for every pixel. An opaque source can bypass `over`.
   The CPU smooth presenter repeats horizontal coordinate calculation on every
   row; precomputed column mappings, row reuse and integer residual mapping can
   preserve its exact selection rule. `core.render` also clears/draws the legacy
   framebuffer before `apply_output` overwrites it for a fully resource-presented
   frame. Skip only proven-obsolete pixel writes, preserving validation.

6. **Trim submission overhead after the larger costs are measured.**
   Cache uniform locations and per-buffer vertex-array configuration.
   `queueMesh` currently copies two matrices and a light vector into three typed
   arrays for every mesh: 99 small arrays and 4,620 numeric payload bytes per
   33-draw frame. That ownership copy is understandable, but storage can be
   pooled. Replacing constant-size `texImage2D` updates with allocated storage
   plus subimage updates is another isolated experiment. Camera recreation is
   observable but update p95 is already about 0.2 ms, so it is a low priority.

The independent viewer has no corresponding CPU geometry-accounting loop or
CPU enlarged presenter to compare directly. Its corresponding operations are
the scene vertex shader, GPU clipping, resolve shader and presentation shader in
`river-live.js`. A CPU-versus-CPU language experiment would need the same data,
accounting rules, arithmetic precision and observable outputs in both languages.
Neither this source inspection nor the existing reports imply that Wasm must
outperform JavaScript.

## Comparison limits and next measurements

The retained viewer report recorded CPU submission p95 of 0.1–0.2 ms and GPU
total p95 of 0.176–2.028 ms across its snapped, supersampled, smooth-presentation
cases. Its synchronized render/finish/one-pixel-readback diagnostic had p95 of
1.1–4.4 ms. A one-pixel diagnostic does not reproduce the console's full
color/depth readback and Wasm copy-back. These results show hardware headroom for
the viewer pipeline, not the throughput of equivalent console work.

Camera trajectories, tessellation, shader work, draw counts and actor motion
differ. The viewer benchmark bypasses its ordinary UI/simulation loop; the
console cartridge performs a small qualification update. The shared browser
runtime already builds with speed optimization. Neither an unoptimized build
nor a language-performance conclusion follows from this comparison.

For the resident/presentation rerun, separate these costs:

- CPU validation, allocation/zero/copy, transforms, clipping and work accounting.
- GPU submission time and GPU execution of initialization, scene, resolve and
  final presentation; use asynchronous GPU timer queries where supported.
- Each synchronous attachment readback and Wasm copy-back.
- CPU logical composition and GPU presentation preparation.
- Interactive worker turnaround, catch-up count, bitmap delivery and actual
  displayed frame intervals.

Use a fixed artifact and replay for each comparison. Hold geometry, matrices,
viewport, supersampling, overscan, resolve rules and synchronization policy
constant; then change one mechanism at a time. Count transformed vertices,
trivial accepts/rejects, clipped triangles, bytes zeroed/copied/uploaded/read,
allocation calls and cache misses. Pair broad CPU timings with asynchronous GPU
timer queries; keep correctness readbacks outside presentation-only throughput
timing and explicitly label that distinction. Separately measure the full path
when CPU consumers require synchronization.

Remaining accounting, clipping, logical composition and synchronous transfers
could still exceed 16.67 ms after residency and GPU presentation. The old draw
stage alone exceeded that budget, but the report does not isolate how much the
new path removes. It supports neither a 60 fps promise nor a prediction that the
remaining path necessarily fails. A focused rerun must resolve that question.

Retain per-frame totals and stage distributions; adding stage p95 values does
not produce a total p95. Match camera replays and preserve logical correctness
checks, resource bounds and rollback behavior. A synchronized offscreen render
benchmark still does not include compositor or scanout latency.

This investigation inspected project sources, existing reports and the
hash-matched measured Wasm binary. It did not run new benchmarks, builds or tests,
and introduces no new performance claims about the unfinished GPU changes.
