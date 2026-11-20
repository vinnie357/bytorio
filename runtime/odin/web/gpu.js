import { surfacePatches, SURFACE_POINTS_PER_PATCH } from "./gpu-surface.js";
import { resourceSchema } from "./constants.js";

const RASTER_VERTEX_BYTES = 7 * Float32Array.BYTES_PER_ELEMENT;
const RESIDENT_VERTEX_FLOATS = 12;
const TEXTURED_RASTER_VERTEX_BYTES = 9 * Float32Array.BYTES_PER_ELEMENT;
const TEXTURED_RESIDENT_VERTEX_FLOATS = 14;
const GPU_CACHE_BYTES = 64 * 1024 * 1024;
const GPU_TEXTURE_CACHE_BYTES = 32 * 1024 * 1024;
const GPU_CACHE_ENTRIES = 1024;

export function normalizeGraphics(value = {}) {
  const backend = value.backend || "cpu";
  const ssaa = value.ssaa || "off";
  if (!["cpu", "gpu", "auto"].includes(backend) || !["off", "2x", "1080p"].includes(ssaa)) {
    throw new Error("Invalid graphics settings.");
  }
  if (backend === "cpu" && value.surfaceSamples) {
    throw new Error("Whole-scene surface samples require the GPU renderer.");
  }
  if (backend === "cpu" && value.residentMeshes) {
    throw new Error("Resident meshes require the GPU renderer.");
  }
  return {
    backend,
    ssaa,
    pixelSnap: Boolean(value.pixelSnap || value.smoothPan || value.surfaceSamples),
    smoothPan: Boolean(value.smoothPan),
    residentMeshes: Boolean(value.residentMeshes || value.surfaceSamples),
    surfaceSamples: Boolean(value.surfaceSamples),
  };
}

export async function createGpu(settings) {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) {
    throw new Error("WebGL 2 is unavailable.");
  }
  const names = [
    "fullscreen.vert",
    "mesh.vert",
    "initialize.frag",
    "mesh.frag",
    "resolve.frag",
    "resident.vert",
    "present.frag",
  ];
  const sources = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => {
        const response = await fetch(new URL(`./gpu-shaders/${name}`, import.meta.url));
        if (!response.ok) {
          throw new Error(`Cannot load GPU shader ${name}.`);
        }
        return [name, await response.text()];
      }),
    ),
  );
  const compile = (kind, code) => {
    const shader = gl.createShader(kind);
    gl.shaderSource(
      shader,
      `#version 300 es\nprecision highp float;\nprecision highp int;\n${code}`,
    );
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  };
  const program = (vertex, fragment) => {
    const shaders = [
      compile(gl.VERTEX_SHADER, sources[vertex]),
      compile(gl.FRAGMENT_SHADER, sources[fragment]),
    ];
    const p = gl.createProgram();
    shaders.forEach((s) => gl.attachShader(p, s));
    gl.linkProgram(p);
    shaders.forEach((s) => gl.deleteShader(s));
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p));
    }
    return p;
  };
  const init = program("fullscreen.vert", "initialize.frag");
  const mesh = program("mesh.vert", "mesh.frag");
  const resolve = program("fullscreen.vert", "resolve.frag");
  const resident = program("resident.vert", "mesh.frag");
  const presentProgram = program("fullscreen.vert", "present.frag");
  const texture = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
      gl.texParameteri(gl.TEXTURE_2D, parameter, gl.NEAREST);
    }
    for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
      gl.texParameteri(gl.TEXTURE_2D, parameter, gl.CLAMP_TO_EDGE);
    }
    return t;
  };
  const input = [texture(), texture()];
  const presentInput = [texture(), texture()];
  const hud = texture();
  const high = {
    fbo: gl.createFramebuffer(),
    color: texture(),
    depthBits: texture(),
    depth: texture(),
  };
  const low = { fbo: gl.createFramebuffer(), color: texture(), depthBits: texture() };
  const frames = [null, null];
  let committedFrame = 0;
  let currentFactor = 1;
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  const residentVao = gl.createVertexArray();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, RASTER_VERTEX_BYTES, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, RASTER_VERTEX_BYTES, 16);
  gl.disable(gl.DITHER);
  const cache = new Map();
  const materialCache = new Map();
  let materialCacheBytes = 0;
  let queuedTexture = null;
  let cacheBytes = 0;
  const metrics = {
    publishedFrames: 0,
    directPresents: 0,
    snapshotReadbackBytes: 0,
    presentationUploadBytes: 0,
    frameBytes: 0,
    attachmentUploadBytes: 0,
    attachmentReadbackBytes: 0,
    attachmentBatches: 0,
    attachmentSequences: 0,
    attachmentBytes: 0,
    meshUploads: 0,
    cacheHits: 0,
    uploadBytes: 0,
    textureUploadBytes: 0,
    cacheBytes: 0,
    textureBytes: 0,
    materialUploads: 0,
    materialCacheHits: 0,
    materialUploadBytes: 0,
    materialCacheBytes: 0,
  };
  const textureStorage = new Map();
  let draws = [];
  let pendingAttachments = false;
  const clearMeshes = () => {
    for (const entry of cache.values()) {
      gl.deleteBuffer(entry.buffer);
    }
    cache.clear();
    cacheBytes = 0;
    metrics.cacheBytes = 0;
  };
  const cachedMesh = (memory, draw) => {
    const key = `${draw.high}:${draw.low}`;
    const palette = draw.palette ? new Uint8Array(memory.buffer, draw.palette, 1024) : null;
    let entry = cache.get(key);
    const same =
      entry &&
      Boolean(palette) === Boolean(entry.palette) &&
      (!palette || palette.every((value, i) => value === entry.palette[i]));
    if (same) {
      metrics.cacheHits++;
      return entry;
    }
    const data = new DataView(memory.buffer, draw.data);
    const vertexFloats = draw.textured ? TEXTURED_RESIDENT_VERTEX_FLOATS : RESIDENT_VERTEX_FLOATS;
    const sourceStride = draw.textured
      ? resourceSchema.texturedVertexBytes
      : resourceSchema.meshVertexBytes;
    const samples =
      settings.surfaceSamples && !draw.textured
        ? surfacePatches(data, draw.vertexCount, draw.indexCount, palette)
        : null;
    const bytes = samples ? samples.byteLength : draw.indexCount * vertexFloats * 4;
    if (bytes > GPU_CACHE_BYTES) {
      throw new Error("GPU mesh cache entry exceeds its bound.");
    }
    if (cacheBytes + bytes > GPU_CACHE_BYTES || cache.size >= GPU_CACHE_ENTRIES) {
      clearMeshes();
      entry = null;
    }
    const vertices = samples || new Float32Array(draw.indexCount * vertexFloats);
    for (let triangle = 0; !samples && triangle < draw.indexCount; triangle += 3) {
      const points = [],
        colors = [];
      for (let i = 0; i < 3; i++) {
        const at =
          data.getUint32(draw.vertexCount * sourceStride + (triangle + i) * 4, true) * sourceStride;
        points.push([0, 1, 2].map((axis) => data.getFloat32(at + axis * 4, true)));
        const color = data.getUint32(at + 12, true);
        colors.push(
          palette
            ? new DataView(palette.buffer, palette.byteOffset, palette.byteLength).getUint32(
                color * 4,
                true,
              )
            : color,
        );
      }
      for (let i = 0; i < 3; i++) {
        const at = (triangle + i) * vertexFloats;
        for (let axis = 0; axis < 3; axis++) {
          vertices[at + axis] = points[i][axis];
          vertices[at + axis + 3] = ((colors[i] >>> (axis * 8)) & 255) / 255;
          vertices[at + axis + 6] = points[1][axis] - points[0][axis];
          vertices[at + axis + 9] = points[2][axis] - points[0][axis];
        }
        if (draw.textured) {
          const source =
            data.getUint32(draw.vertexCount * sourceStride + (triangle + i) * 4, true) *
            sourceStride;
          for (let axis = 0; axis < 2; axis++) {
            vertices[at + RESIDENT_VERTEX_FLOATS + axis] = data.getFloat32(
              source + resourceSchema.texturedUvOffset + axis * 4,
              true,
            );
          }
        }
      }
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteBuffer(buffer);
      throw new Error("GPU mesh upload failed.");
    }
    if (entry) {
      gl.deleteBuffer(entry.buffer);
      cacheBytes -= entry.bytes;
    }
    const result = {
      buffer,
      bytes,
      count: vertices.length / vertexFloats,
      palette: palette?.slice(),
    };
    cache.set(key, result);
    cacheBytes += bytes;
    metrics.cacheBytes = cacheBytes;
    metrics.meshUploads++;
    metrics.uploadBytes += bytes;
    return result;
  };
  const allocate = (t, w, h, depth = false, bytes = null, mask = false) => {
    gl.bindTexture(gl.TEXTURE_2D, t);
    const format = mask ? gl.RED : depth ? gl.DEPTH_COMPONENT : gl.RGBA;
    const type = depth ? gl.FLOAT : gl.UNSIGNED_BYTE;
    const previous = textureStorage.get(t);
    const key = `${w}/${h}/${format}`;
    if (previous?.key === key) {
      if (bytes) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, type, bytes);
      }
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        mask ? gl.R8 : depth ? gl.DEPTH_COMPONENT32F : gl.RGBA8,
        w,
        h,
        0,
        format,
        type,
        bytes,
      );
      const size = w * h * (mask ? 1 : 4);
      metrics.textureBytes += size - (previous?.size || 0);
      textureStorage.set(t, { key, size });
      if (
        input.includes(t) ||
        [high.color, high.depthBits, high.depth, low.color, low.depthBits].includes(t)
      ) {
        metrics.attachmentBytes += size - (previous?.size || 0);
      }
    }
    if (bytes) {
      metrics.textureUploadBytes += bytes.byteLength;
    }
  };
  const clearTextures = () => {
    for (const entry of materialCache.values()) {
      gl.deleteTexture(entry.texture);
      const storage = textureStorage.get(entry.texture);
      metrics.textureBytes -= storage?.size || 0;
      textureStorage.delete(entry.texture);
    }
    materialCache.clear();
    materialCacheBytes = 0;
    metrics.materialCacheBytes = 0;
  };
  const bindMaterial = (memory, program, material) => {
    gl.uniform1i(gl.getUniformLocation(program, "useTexture"), Number(Boolean(material)));
    gl.uniform1i(gl.getUniformLocation(program, "materialTexture"), 2);
    gl.uniform1i(gl.getUniformLocation(program, "alphaCutout"), Number(Boolean(material?.cutout)));
    gl.uniform1i(gl.getUniformLocation(program, "alphaCutoff"), material?.alphaCutoff || 0);
    gl.uniform1i(
      gl.getUniformLocation(program, "effectMaterial"),
      Number(Boolean(material?.effect)),
    );
    gl.uniform1i(
      gl.getUniformLocation(program, "additiveMaterial"),
      Number(Boolean(material?.additive)),
    );
    gl.activeTexture(gl.TEXTURE2);
    if (!material) {
      gl.bindTexture(gl.TEXTURE_2D, input[0]);
      return;
    }
    const key = `${material.high}:${material.low}`;
    let entry = materialCache.get(key);
    if (entry) {
      metrics.materialCacheHits++;
    } else {
      const size = material.width * material.height * 4;
      if (size > GPU_TEXTURE_CACHE_BYTES || (!material.low && !material.high)) {
        throw new Error("Invalid GPU texture snapshot.");
      }
      if (
        materialCacheBytes + size > GPU_TEXTURE_CACHE_BYTES ||
        materialCache.size >= GPU_CACHE_ENTRIES
      ) {
        clearTextures();
      }
      const value = texture();
      allocate(
        value,
        material.width,
        material.height,
        false,
        new Uint8Array(memory.buffer, material.pixels, size),
      );
      if (gl.getError() !== gl.NO_ERROR) {
        gl.deleteTexture(value);
        metrics.textureBytes -= textureStorage.get(value)?.size || 0;
        textureStorage.delete(value);
        throw new Error("GPU texture upload failed.");
      }
      entry = { texture: value, size };
      materialCache.set(key, entry);
      materialCacheBytes += size;
      metrics.materialUploads++;
      metrics.materialUploadBytes += size;
      metrics.materialCacheBytes = materialCacheBytes;
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.uniform2i(
      gl.getUniformLocation(program, "textureAddress"),
      material.addressU,
      material.addressV,
    );
  };
  const target = (value, w, h) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, value.fbo);
    for (const [t, attachment, depth] of [
      [value.color, gl.COLOR_ATTACHMENT0, false],
      [value.depthBits, gl.COLOR_ATTACHMENT1, false],
      ...(value.depth ? [[value.depth, gl.DEPTH_ATTACHMENT, true]] : []),
    ]) {
      allocate(t, w, h, depth);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, t, 0);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("GPU framebuffer is incomplete.");
    }
  };
  let dimensions = "",
    resultColor,
    resultDepth;
  const quad = (p, a, b, factor, w, h, border = 0) => {
    gl.useProgram(p);
    for (const [unit, t, name] of [
      [0, a, "colorSource"],
      [1, b, "depthSource"],
    ]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(gl.getUniformLocation(p, name), unit);
    }
    gl.uniform1i(gl.getUniformLocation(p, "factor"), factor);
    gl.uniform1i(gl.getUniformLocation(p, "border"), border);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  return {
    gl,
    metrics,
    invalidateFrames() {
      for (const frame of frames) {
        if (frame) {
          frame.version = null;
        }
      }
      pendingAttachments = false;
    },
    publishFrame(low, high) {
      const candidate = frames[1 - committedFrame];
      if (!(low || high) || candidate?.version !== `${high}:${low}`) {
        return 0;
      }
      committedFrame = 1 - committedFrame;
      pendingAttachments = false;
      metrics.publishedFrames++;
      return 1;
    },
    stageFrame(memory, color, _depth, preview, mask, width, height, lowWord, highWord) {
      const border = preview ? 1 : 0;
      const rw = width + border * 2,
        rh = height + border * 2;
      if (!pendingAttachments || dimensions !== `${rw}/${rh}/${currentFactor}`) {
        return 0;
      }
      const index = 1 - committedFrame;
      const frame = (frames[index] ||= {
        fbo: gl.createFramebuffer(),
        color: texture(),
        depthBits: texture(),
        hud: texture(),
        mask: texture(),
        version: null,
      });
      frame.version = null;
      target(frame, rw, rh);
      gl.bindVertexArray(vao);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);
      quad(resolve, high.color, high.depthBits, currentFactor, rw, rh);
      frame.hasHud = Boolean(mask);
      if (mask) {
        gl.activeTexture(gl.TEXTURE0);
        allocate(
          frame.hud,
          width,
          height,
          false,
          new Uint8Array(memory.buffer, color, width * height * 4),
        );
        allocate(
          frame.mask,
          width,
          height,
          false,
          new Uint8Array(memory.buffer, mask, width * height),
          true,
        );
        metrics.presentationUploadBytes += width * height * 5;
      }
      metrics.frameBytes = frames.reduce(
        (sum, entry) =>
          sum +
          (entry
            ? [entry.color, entry.depthBits, entry.hud, entry.mask].reduce(
                (size, t) => size + (textureStorage.get(t)?.size || 0),
                0,
              )
            : 0),
        0,
      );
      if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
        return 0;
      }
      Object.assign(frame, { width, height, border, version: `${highWord}:${lowWord}` });
      return 1;
    },
    readFrame(memory, color, depth, preview, mask, width, height, lowWord, highWord) {
      const frame = frames[committedFrame];
      const border = preview ? 1 : 0;
      if (
        !(lowWord || highWord) ||
        frame?.version !== `${highWord}:${lowWord}` ||
        frame.width !== width ||
        frame.height !== height ||
        frame.border !== border
      ) {
        return 0;
      }
      const rw = width + border * 2,
        rh = height + border * 2;
      const colors = new Uint8Array(rw * rh * 4),
        depths = new Uint8Array(colors.length);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frame.fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, colors);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(0, 0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, depths);
      metrics.snapshotReadbackBytes += colors.length + depths.length;
      metrics.attachmentReadbackBytes += colors.length + depths.length;
      if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
        return 0;
      }
      const bytes = new Uint8Array(memory.buffer);
      for (let y = 0; y < height; y++) {
        const source = ((y + border) * rw + border) * 4;
        const row = new Uint8Array(memory.buffer, color + y * width * 4, width * 4);
        if (!mask) {
          row.set(colors.subarray(source, source + row.length));
        } else {
          for (let x = 0; x < width; x++) {
            if (!bytes[mask + y * width + x]) {
              row.set(colors.subarray(source + x * 4, source + x * 4 + 4), x * 4);
            }
          }
        }
        new Uint8Array(memory.buffer, depth + y * width * 4, width * 4).set(
          depths.subarray(source, source + width * 4),
        );
      }
      if (preview) {
        new Uint8Array(memory.buffer, preview, colors.length).set(colors);
      }
      return 1;
    },
    queueTexture(
      pixels,
      width,
      height,
      low,
      high,
      addressU,
      addressV,
      cutout = 0,
      alphaCutoff = 0,
      effect = 0,
      additive = 0,
      skipDepthTest = 0,
      skipDepthWrite = 0,
    ) {
      queuedTexture = pixels
        ? {
            pixels,
            width,
            height,
            low,
            high,
            addressU,
            addressV,
            cutout: Boolean(cutout),
            alphaCutoff,
            effect: Boolean(effect),
            additive: Boolean(additive),
            skipDepthTest: Boolean(skipDepthTest),
            skipDepthWrite: Boolean(skipDepthWrite),
          }
        : null;
    },
    queueMesh(
      memory,
      low,
      high,
      data,
      vertexCount,
      indexCount,
      palette,
      model,
      view,
      light,
      ambient,
      textured = 0,
    ) {
      draws.push({
        low,
        high,
        data,
        vertexCount,
        indexCount,
        palette,
        model: new Float32Array(memory.buffer, model, 16).slice(),
        view: new Float32Array(memory.buffer, view, 16).slice(),
        light: new Float32Array(memory.buffer, light, 3).slice(),
        ambient,
        textured: Boolean(textured),
      });
    },
    present(
      memory,
      output,
      preview,
      mask,
      width,
      height,
      availableWidth,
      availableHeight,
      dx,
      dy,
      background,
      versionLow = 0,
      versionHigh = 0,
    ) {
      const direct = Boolean(versionLow || versionHigh);
      const snapshot = frames[committedFrame];
      if (
        direct &&
        (snapshot?.version !== `${versionHigh}:${versionLow}` ||
          snapshot.width !== width ||
          snapshot.height !== height)
      ) {
        throw new Error("Committed GPU snapshot is unavailable.");
      }
      const scale = preview
        ? Math.max(
            1,
            Math.min(
              6,
              Math.floor(1920 / width),
              Math.floor(1080 / height),
              Math.floor(availableWidth / width),
              Math.floor(availableHeight / height),
            ),
          )
        : 1;
      const smooth = Boolean(preview && scale > 1);
      const w = width * scale,
        h = height * scale;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(presentProgram);
      gl.activeTexture(gl.TEXTURE0);
      if (direct) {
        gl.bindTexture(gl.TEXTURE_2D, snapshot.color);
        metrics.directPresents++;
      } else {
        allocate(
          presentInput[0],
          smooth ? width + 2 : width,
          smooth ? height + 2 : height,
          false,
          new Uint8Array(
            memory.buffer,
            smooth ? preview : output,
            (smooth ? (width + 2) * (height + 2) : width * height) * 4,
          ),
        );
      }
      gl.uniform1i(gl.getUniformLocation(presentProgram, "colorSource"), 0);
      for (const unit of [1, 2]) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, direct ? snapshot.color : presentInput[0]);
      }
      gl.uniform1i(gl.getUniformLocation(presentProgram, "depthSource"), 1);
      gl.uniform1i(gl.getUniformLocation(presentProgram, "hudSource"), 2);
      if (direct && snapshot.hasHud) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, snapshot.hud);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, snapshot.mask);
      } else if (!direct && smooth) {
        gl.activeTexture(gl.TEXTURE1);
        allocate(
          presentInput[1],
          width,
          height,
          false,
          new Uint8Array(memory.buffer, output, width * height * 4),
        );
        gl.uniform1i(gl.getUniformLocation(presentProgram, "depthSource"), 1);
        gl.activeTexture(gl.TEXTURE2);
        allocate(
          hud,
          width,
          height,
          false,
          new Uint8Array(memory.buffer, mask, width * height),
          true,
        );
        gl.uniform1i(gl.getUniformLocation(presentProgram, "hudSource"), 2);
      }
      gl.uniform2i(gl.getUniformLocation(presentProgram, "logicalSize"), width, height);
      gl.uniform1i(gl.getUniformLocation(presentProgram, "flipY"), 1);
      gl.uniform1i(gl.getUniformLocation(presentProgram, "outputHeight"), h);
      gl.uniform2f(
        gl.getUniformLocation(presentProgram, "residual"),
        Math.round(dx * scale) / scale,
        Math.round(dy * scale) / scale,
      );
      gl.uniform1i(gl.getUniformLocation(presentProgram, "scale"), scale);
      gl.uniform1i(gl.getUniformLocation(presentProgram, "useSmooth"), Number(smooth));
      gl.uniform1i(
        gl.getUniformLocation(presentProgram, "useHud"),
        Number(direct ? snapshot.hasHud : smooth),
      );
      gl.uniform1i(
        gl.getUniformLocation(presentProgram, "sourceBorder"),
        direct ? snapshot.border : smooth ? 1 : 0,
      );
      gl.uniform4f(
        gl.getUniformLocation(presentProgram, "background"),
        (background & 255) / 255,
        ((background >>> 8) & 255) / 255,
        ((background >>> 16) & 255) / 255,
        (background >>> 24) / 255,
      );
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
        throw new Error("GPU presentation failed.");
      }
      return {
        bitmap: canvas.transferToImageBitmap(),
        presentationWidth: w,
        presentationHeight: h,
        smoothPresentation: smooth,
      };
    },
    finish() {
      gl.finish();
    },
    close() {
      clearMeshes();
      clearTextures();
      for (const frame of frames) {
        if (!frame) {
          continue;
        }
        for (const entry of [frame.color, frame.depthBits, frame.hud, frame.mask]) {
          gl.deleteTexture(entry);
        }
        gl.deleteFramebuffer(frame.fbo);
      }
      const lose = gl.getExtension("WEBGL_lose_context");
      lose?.loseContext();
    },
    raster(
      memory,
      vertices,
      count,
      color,
      depth,
      width,
      height,
      cx,
      cy,
      cw,
      ch,
      fogColor,
      fogStart,
      fogEnd,
      borderOutput = 0,
      continuation = 0,
      deferReadback = 0,
      maskOutput = 0,
    ) {
      const wasPending = pendingAttachments;
      pendingAttachments = false;
      const batch = draws;
      draws = [];
      const material = queuedTexture;
      queuedTexture = null;
      const stride = material ? TEXTURED_RASTER_VERTEX_BYTES : RASTER_VERTEX_BYTES;
      if (width < 1 || height < 1 || width > 1920 || height > 1080) {
        return 0;
      }
      const desiredFactor =
        settings.ssaa === "1080p"
          ? Math.max(1, Math.min(6, Math.floor(1920 / width), Math.floor(1080 / height)))
          : settings.ssaa === "2x"
            ? 2
            : 1;
      const factor = Math.max(
        1,
        Math.min(desiredFactor, Math.floor(1920 / width), Math.floor(1080 / height)),
      );
      const border = borderOutput ? 1 : 0;
      const rw = width + border * 2,
        rh = height + border * 2;
      if (rw * rh * factor * factor > 1932 * 1092) {
        return 0;
      }
      const key = `${rw}/${rh}/${factor}`;
      currentFactor = factor;
      if (continuation && (!wasPending || dimensions !== key)) {
        return 0;
      }
      if (dimensions !== key) {
        target(high, rw * factor, rh * factor);
        target(low, rw, rh);
        resultColor = new Uint8Array(rw * rh * 4);
        resultDepth = new Uint8Array(rw * rh * 4);
        dimensions = key;
      }
      gl.bindVertexArray(vao);
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, high.fbo);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.enable(gl.DEPTH_TEST);
      if (!continuation) {
        gl.depthFunc(gl.ALWAYS);
        gl.activeTexture(gl.TEXTURE0);
        allocate(
          input[0],
          width,
          height,
          false,
          new Uint8Array(memory.buffer, color, width * height * 4),
        );
        allocate(
          input[1],
          width,
          height,
          false,
          new Uint8Array(memory.buffer, depth, width * height * 4),
        );
        quad(init, input[0], input[1], factor, rw * factor, rh * factor, border);
        metrics.attachmentUploadBytes += width * height * 8;
        metrics.attachmentSequences++;
      }
      gl.viewport(0, 0, rw * factor, rh * factor);
      gl.depthFunc(gl.LESS);
      gl.enable(gl.SCISSOR_TEST);
      const x0 = Math.max(0, cx),
        y0 = Math.max(0, cy),
        x1 = Math.min(width, cx + cw),
        y1 = Math.min(height, cy + ch);
      gl.scissor(
        x0 * factor,
        y0 * factor,
        Math.max(0, x1 - x0) * factor,
        Math.max(0, y1 - y0) * factor,
      );
      if (border) {
        gl.disable(gl.SCISSOR_TEST);
      }
      const program = batch.length ? resident : mesh;
      gl.useProgram(program);
      gl.uniform2f(gl.getUniformLocation(program, "logicalSize"), width, height);
      gl.uniform1i(gl.getUniformLocation(program, "border"), border);
      gl.uniform3f(
        gl.getUniformLocation(program, "fogColor"),
        (fogColor & 255) / 255,
        ((fogColor >>> 8) & 255) / 255,
        ((fogColor >>> 16) & 255) / 255,
      );
      gl.uniform2f(gl.getUniformLocation(program, "fogRange"), fogStart, fogEnd);
      bindMaterial(memory, program, material);
      if (batch.length || count) {
        metrics.attachmentBatches++;
      }
      const effect = material?.effect;
      const drawTriangles = (count) => {
        if (!effect) {
          gl.drawArrays(gl.TRIANGLES, 0, count);
          return;
        }
        // Publish depth per primitive, preserving order inside a mesh.
        const step = material.skipDepthWrite ? count : 3;
        for (let first = 0; first < count; first += step) {
          gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, material.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          gl.depthFunc(material.skipDepthTest ? gl.ALWAYS : gl.LESS);
          gl.drawArrays(gl.TRIANGLES, first, step);
          if (!material.skipDepthWrite) {
            gl.drawBuffers([gl.NONE, gl.COLOR_ATTACHMENT1]);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.drawArrays(gl.TRIANGLES, first, step);
          }
        }
      };
      if (batch.length) {
        gl.uniform1i(
          gl.getUniformLocation(program, "surfaceSamples"),
          Number(settings.surfaceSamples && !material),
        );
        gl.bindVertexArray(residentVao);
        for (const draw of batch) {
          if (
            settings.surfaceSamples &&
            !draw.textured &&
            (draw.view[3] !== 0 || draw.view[7] !== 0 || draw.view[11] !== 0 || draw.view[15] !== 1)
          ) {
            throw new Error("Surface samples require an orthographic camera.");
          }
          const entry = cachedMesh(memory, draw);
          const vertexFloats = draw.textured
            ? TEXTURED_RESIDENT_VERTEX_FLOATS
            : RESIDENT_VERTEX_FLOATS;
          const samples = settings.surfaceSamples && !draw.textured;
          gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
          for (let i = 0; i < 4; i++) {
            gl.enableVertexAttribArray(i);
            gl.vertexAttribPointer(i, 3, gl.FLOAT, false, vertexFloats * 4, i * 12);
            gl.vertexAttribDivisor(i, samples ? SURFACE_POINTS_PER_PATCH : 0);
          }
          if (draw.textured) {
            gl.enableVertexAttribArray(4);
            gl.vertexAttribPointer(
              4,
              2,
              gl.FLOAT,
              false,
              vertexFloats * 4,
              RESIDENT_VERTEX_FLOATS * 4,
            );
            gl.vertexAttribDivisor(4, 0);
          } else {
            gl.disableVertexAttribArray(4);
          }
          gl.uniformMatrix4fv(gl.getUniformLocation(program, "model"), false, draw.model);
          gl.uniformMatrix4fv(gl.getUniformLocation(program, "view"), false, draw.view);
          gl.uniform3fv(gl.getUniformLocation(program, "light"), draw.light);
          gl.uniform1f(gl.getUniformLocation(program, "ambient"), draw.ambient);
          if (samples) {
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, entry.count * SURFACE_POINTS_PER_PATCH);
          } else {
            drawTriangles(draw.indexCount);
          }
        }
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Uint8Array(memory.buffer, vertices, count * stride),
          gl.STREAM_DRAW,
        );
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 16);
        if (material) {
          gl.enableVertexAttribArray(2);
          gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, RASTER_VERTEX_BYTES);
        } else {
          gl.disableVertexAttribArray(2);
        }
        metrics.uploadBytes += count * stride;
        drawTriangles(count);
      }
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.bindVertexArray(vao);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);
      if (deferReadback) {
        if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
          return 0;
        }
        pendingAttachments = true;
        return 1;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, low.fbo);
      quad(resolve, high.color, high.depthBits, factor, rw, rh);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, resultColor);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(0, 0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, resultDepth);
      metrics.attachmentReadbackBytes += rw * rh * 8;
      if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
        return 0;
      }
      const bytes = new Uint8Array(memory.buffer);
      for (let y = 0; y < height; y++) {
        const source = ((y + border) * rw + border) * 4;
        const row = new Uint8Array(memory.buffer, color + y * width * 4, width * 4);
        if (!maskOutput) {
          row.set(resultColor.subarray(source, source + width * 4));
        } else {
          for (let x = 0; x < width; x++) {
            if (!bytes[maskOutput + y * width + x]) {
              row.set(resultColor.subarray(source + x * 4, source + x * 4 + 4), x * 4);
            }
          }
        }
        new Uint8Array(memory.buffer, depth + y * width * 4, width * 4).set(
          resultDepth.subarray(source, source + width * 4),
        );
      }
      if (borderOutput) {
        new Uint8Array(memory.buffer, borderOutput, resultColor.length).set(resultColor);
      }
      return 1;
    },
  };
}
