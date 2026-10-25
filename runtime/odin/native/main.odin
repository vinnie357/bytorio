package main

import abi "../abi"
import mixer "../audio"
import branding "../branding"
import cartridge "../cartridge"
import core "../core"
import gpu "../gpu/native"
import guest "../guest"
import presentation "../presentation"
import w "../resource_protocol"
import resources "../resources"
import timing "../timing"
import "core:fmt"
import "core:os"
import "core:strconv"
import "core:strings"
import sdl "vendor:sdl3"

read_bounded :: proc(path: string, limit: int) -> (data: []u8, message: string) {
    file, open_error := os.open(path)
    if open_error != nil {

        return nil, "cannot open cartridge or source file"
    }
    defer os.close(file)
    size, size_error := os.file_size(file)
    if size_error != nil || size <= 0 || size > i64(limit) {

        return nil, "cartridge or source file exceeds size limit or is empty"
    }
    data = make([]u8, int(size))
    count, read_error := os.read_full(file, data)
    if read_error != nil || count != len(data) {

        delete(data)
        return nil, "cannot read complete cartridge or source file"
    }
    return data, ""
}

App :: struct {
    presenter:                     presentation.State,
    gpu_enabled:                   bool,
    gpu_window:                    bool,
    title_base:                    string,
    stats_started:                 f64,
    stats_frames:                  u32,
    title_buffer:                  [512]u8,
    present_pixels:                []u32,
    game:                          guest.Game,
    frame:                         abi.Frame,
    window:                        ^sdl.Window,
    renderer:                      ^sdl.Renderer,
    texture:                       ^sdl.Texture,
    audio:                         ^sdl.AudioStream,
    mixer_audio:                   ^sdl.AudioStream,
    audio_paused:                  bool,
    audio_engine:                  ^mixer.Engine,
    audio_buffer:                  [w.maxAudioDeviceBlock * 2]f32,
    gamepad:                       ^sdl.Gamepad,
    focused:                       bool,
    text_revision:                 u32,
    wheel:                         i32,
    texture_width, texture_height: int,
    logical_width, logical_height: int,
    sounds_played, audio_queued:   u32,
}

error :: proc(message: string) -> int {
    fmt.eprintf("player: %s\n", message)
    return 1
}

cleanup :: proc(app: ^App) {
    presentation.close(&app.presenter)
    resources.software_close()
    gpu.close()
    if app.mixer_audio != nil { sdl.DestroyAudioStream(app.mixer_audio) }
    if app.audio != nil {

        sdl.DestroyAudioStream(app.audio)
    }
    if app.gamepad != nil {

        sdl.CloseGamepad(app.gamepad)
    }
    if app.texture != nil {

        sdl.DestroyTexture(app.texture)
    }
    if app.renderer != nil {

        sdl.DestroyRenderer(app.renderer)
    }
    if app.window != nil && !app.gpu_window {

        sdl.DestroyWindow(app.window)
    }
    sdl.Quit()
    guest.close(&app.game)
}

input :: proc(app: ^App) -> abi.Input {
    result: abi.Input
    if !app.focused {

        return result
    }
    keys := sdl.GetKeyboardState(nil)
    if !abi.text_active(&app.game.text_input) {
        if keys[sdl.Scancode.A] { result.buttons |= abi.BUTTON_MOVE_LEFT }
        if keys[sdl.Scancode.D] { result.buttons |= abi.BUTTON_MOVE_RIGHT }
        if keys[sdl.Scancode.W] { result.buttons |= abi.BUTTON_MOVE_UP }
        if keys[sdl.Scancode.S] { result.buttons |= abi.BUTTON_MOVE_DOWN }
        if keys[sdl.Scancode.LEFT] { result.buttons |= abi.BUTTON_PAN_LEFT }
        if keys[sdl.Scancode.RIGHT] { result.buttons |= abi.BUTTON_PAN_RIGHT }
        if keys[sdl.Scancode.UP] { result.buttons |= abi.BUTTON_PAN_UP }
        if keys[sdl.Scancode.DOWN] { result.buttons |= abi.BUTTON_PAN_DOWN }
        if keys[sdl.Scancode.Q] { result.buttons |= abi.BUTTON_ROTATE_LEFT }
        if keys[sdl.Scancode.E] { result.buttons |= abi.BUTTON_ROTATE_RIGHT }
        if keys[sdl.Scancode.R] { result.buttons |= abi.BUTTON_RESET }
        if keys[sdl.Scancode.I] { result.buttons |= abi.BUTTON_INVENTORY }
        if keys[sdl.Scancode.C] { result.buttons |= abi.BUTTON_CHARACTER }
        if keys[sdl.Scancode.K] { result.buttons |= abi.BUTTON_SKILLS }
        if keys[sdl.Scancode.Q] { result.buttons |= abi.BUTTON_QUEST }
        if keys[sdl.Scancode.TAB] { result.buttons |= abi.BUTTON_MAP }
        if keys[sdl.Scancode._1] { result.buttons |= abi.BUTTON_POTION_1 }
        if keys[sdl.Scancode._2] { result.buttons |= abi.BUTTON_POTION_2 }
        if keys[sdl.Scancode._3] { result.buttons |= abi.BUTTON_POTION_3 }
        if keys[sdl.Scancode._4] { result.buttons |= abi.BUTTON_POTION_4 }
        if keys[sdl.Scancode.LSHIFT] ||
           keys[sdl.Scancode.RSHIFT] { result.buttons |= abi.BUTTON_SHIFT }
        if keys[sdl.Scancode.ESCAPE] { result.buttons |= abi.BUTTON_ESCAPE }
        if app.wheel > 0 { result.buttons |= abi.BUTTON_WHEEL_UP }
        if app.wheel < 0 { result.buttons |= abi.BUTTON_WHEEL_DOWN }
        app.wheel = 0
        if keys[sdl.Scancode.LEFT] || keys[sdl.Scancode.A] {

            result.buttons |= 1
        }
        if keys[sdl.Scancode.RIGHT] || keys[sdl.Scancode.D] {

            result.buttons |= 2
        }
        if keys[sdl.Scancode.UP] || keys[sdl.Scancode.W] {

            result.buttons |= 4
        }
        if keys[sdl.Scancode.DOWN] || keys[sdl.Scancode.S] {

            result.buttons |= 8
        }
        if keys[sdl.Scancode.SPACE] {

            result.buttons |= 16
        }
        if app.gamepad != nil {
            if sdl.GetGamepadButton(app.gamepad, .DPAD_LEFT) {

                result.buttons |= 1 | abi.BUTTON_MOVE_LEFT
            }
            if sdl.GetGamepadButton(app.gamepad, .DPAD_RIGHT) {

                result.buttons |= 2 | abi.BUTTON_MOVE_RIGHT
            }
            if sdl.GetGamepadButton(app.gamepad, .DPAD_UP) {

                result.buttons |= 4 | abi.BUTTON_MOVE_UP
            }
            if sdl.GetGamepadButton(app.gamepad, .DPAD_DOWN) {

                result.buttons |= 8 | abi.BUTTON_MOVE_DOWN
            }
            if sdl.GetGamepadButton(app.gamepad, .SOUTH) {

                result.buttons |= 16
            }
        }
    }
    x, y, lx, ly: f32
    buttons := sdl.GetMouseState(&x, &y)
    mapped := false
    if app.gpu_window {
        w, h, drawable_w, drawable_h: i32
        if sdl.GetWindowSize(app.window, &w, &h) &&
           sdl.GetWindowSizeInPixels(app.window, &drawable_w, &drawable_h) &&
           w > 0 &&
           h > 0 {
            scale := min(f32(drawable_w) / f32(core.width), f32(drawable_h) / f32(core.height))
            if scale >= 1 { scale = f32(int(scale)) }
            if scale > 0 {
                lx =
                    (x * f32(drawable_w) / f32(w) -
                        (f32(drawable_w) - f32(core.width) * scale) / 2) /
                    scale
                ly =
                    (y * f32(drawable_h) / f32(h) -
                        (f32(drawable_h) - f32(core.height) * scale) / 2) /
                    scale
                mapped = true
            }
        }
    } else {
        mapped = sdl.RenderCoordinatesFromWindow(app.renderer, x, y, &lx, &ly)
    }
    if mapped {
        hover :=
            sdl.GetMouseFocus() == app.window &&
            lx >= 0 &&
            lx < f32(core.width) &&
            ly >= 0 &&
            ly < f32(core.height)
        result.pointer = .LEFT in buttons && hover
        if hover {
            result.buttons |= abi.BUTTON_POINTER_HOVER
            if .LEFT in buttons { result.buttons |= abi.BUTTON_POINTER_LEFT }
            if .RIGHT in buttons { result.buttons |= abi.BUTTON_POINTER_RIGHT }
        }
        result.x, result.y = f64(lx), f64(ly)
    }
    return result
}

draw :: proc(app: ^App) -> bool {
    if !guest.draw(&app.game, &app.frame) {

        return false
    }
    return render_current(app)
}

update_window_stats :: proc(app: ^App, new_frame: bool) {
    now := clock_ms()
    if app.stats_started == 0 { app.stats_started = now }
    app.stats_frames += u32(new_frame)
    elapsed := now - app.stats_started
    if elapsed < 500 { return }
    gpu_bytes := gpu.cached_bytes() if app.gpu_enabled else 0
    title := fmt.bprintf(
        app.title_buffer[:],
        "%s | %.1f FPS delivered | guest %.2f MiB | resources %.2f MiB | GPU meshes %.2f MiB\x00",
        app.title_base,
        f64(app.stats_frames) * 1000 / elapsed,
        f64(guest.memory_bytes(&app.game)) / 1048576,
        f64(app.game.resources.bytes) / 1048576,
        f64(gpu_bytes) / 1048576,
    )
    _ = sdl.SetWindowTitle(app.window, cast(cstring)raw_data(title))
    app.stats_started, app.stats_frames = now, 0
}
render_current :: proc(app: ^App) -> bool {
    if !core.set_display(app.game.display_mode) {

        return guest.fail(&app.game, "unsupported display mode")
    }
    if !core.render(app.frame) {

        return guest.fail(&app.game, "invalid frame command")
    }
    valid :=
        core.render_batch(app.game.batch[:app.game.count], app.game.text[:app.game.text_size]) if app.game.stride == 32 else core.render_commands(app.game.commands[:app.game.count])
    if !valid {

        return guest.fail(&app.game, "invalid frame command")
    }
    guest.apply_graphics(&app.game)
    return true
}

display_texture :: proc(app: ^App) -> bool {
    if app.logical_width != core.width || app.logical_height != core.height {
        if !sdl.SetRenderLogicalPresentation(
            app.renderer,
            i32(core.width),
            i32(core.height),
            .INTEGER_SCALE,
        ) { return false }
        app.logical_width, app.logical_height = core.width, core.height
    }
    available_width, available_height: i32
    _ = sdl.GetRenderOutputSize(app.renderer, &available_width, &available_height)
    app.present_pixels = presentation.prepare(
        &app.presenter,
        &app.game.resources,
        int(available_width),
        int(available_height),
    )
    if app.texture != nil &&
       app.texture_width == app.presenter.width &&
       app.texture_height == app.presenter.height {

        return true
    }
    if app.texture != nil {

        sdl.DestroyTexture(app.texture)
        app.texture = nil
    }
    app.texture = sdl.CreateTexture(
        app.renderer,
        .RGBA32,
        .STREAMING,
        i32(app.presenter.width),
        i32(app.presenter.height),
    )
    if app.texture == nil || !sdl.SetTextureScaleMode(app.texture, .NEAREST) {

        return false
    }
    app.texture_width, app.texture_height = app.presenter.width, app.presenter.height
    return true
}

run :: proc() -> int {
    app := new(App)
    defer free(app)
    defer cleanup(app)
    base := sdl.GetBasePath()
    if base == nil {

        return error("cannot locate player directory")
    }
    game_path := fmt.tprintf("%sgame.wasm", base)
    if os.exists(fmt.tprintf("%sgame.png", base)) {

        game_path = fmt.tprintf("%sgame.png", base)
    }
    executor_path := fmt.tprintf("%sluau-executor.wasm", base)
    capture := ""
    raw_capture := ""
    replay_path := ""
    source_path := ""
    benchmark_path := ""
    benchmark_warmup := 0
    unmetered := false
    no_executor_cache := false
    cache_config := ""
    smoke, check_only := false, false
    renderer_choice := "cpu"
    ssaa := "off"
    pixel_snap := false
    smooth_pan := false
    resident_meshes := false
    surface_samples := false
    render_fps := timing.SIMULATION_HZ
    for i := 1; i < len(os.args); i += 1 {
        switch os.args[i] {
        case "--surface-samples":
            surface_samples, resident_meshes, pixel_snap = true, true, true
        case "--gpu-meshes":
            resident_meshes = true
        case "--smooth-pan":
            smooth_pan, pixel_snap = true, true
        case "--pixel-snap":
            pixel_snap = true
        case "--smoke":
            smoke = true
        case "--check":
            check_only = true
        case "--benchmark-unmetered":
            unmetered = true
        case "--no-executor-cache":
            no_executor_cache = true
        case "--game",
             "--fps",
             "--renderer",
             "--ssaa",
             "--capture",
             "--capture-rgba",
             "--replay",
             "--source",
             "--benchmark",
             "--benchmark-warmup",
             "--executor-cache",
             "--executor":
            option := os.args[i]
            i += 1
            if i >= len(os.args) {

                return error("missing option argument")
            }
            if option == "--fps" {
                if os.args[i] == "native" {
                    render_fps = timing.NATIVE_FRAME_RATE
                } else if os.args[i] == "uncapped" {
                    render_fps = timing.UNCAPPED_FRAME_RATE
                } else {
                    decimal := len(os.args[i]) > 0
                    for digit in os.args[i] {
                        if digit < '0' || digit > '9' { decimal = false }
                    }
                    rate, ok := strconv.parse_u64(os.args[i])
                    if !decimal || !ok || rate < 1 || rate > timing.MAX_RENDER_FPS {
                        return error(
                            "frame rate must be an integer from 1 to 240, native, or uncapped",
                        )
                    }
                    render_fps = int(rate)
                }
            } else if option == "--game" {
                game_path = os.args[i]
            } else if option == "--renderer" {
                renderer_choice = os.args[i]
            } else if option == "--ssaa" {
                ssaa = os.args[i]
            } else if option == "--executor" {
                executor_path = os.args[i]
            } else if option == "--source" {
                source_path = os.args[i]
            } else if option == "--executor-cache" {
                cache_config = os.args[i]
            } else if option == "--benchmark" {
                benchmark_path = os.args[i]
                check_only = true
            } else if option == "--benchmark-warmup" {
                frames, ok := strconv.parse_u64(os.args[i])
                if !ok || frames > 10000 { return error("invalid benchmark warmup") }
                benchmark_warmup = int(frames)
            } else if option == "--capture-rgba" {
                raw_capture = os.args[i]
            } else if option == "--replay" {
                replay_path = os.args[i]
                check_only = true
            } else {

                capture = os.args[i]
            }
        case:
            if len(os.args[i]) > 0 && os.args[i][0] != '-' && i == 1 {

                game_path = os.args[i]
                continue
            }
            return error(
                "usage: player [cartridge.png | --game cartridge.png|file.wasm] [--source game.luau] [--executor luau-executor.wasm] [--smoke|--check|--replay inputs|--benchmark inputs [--benchmark-unmetered]] [--capture output.bmp]",
            )
        }
    }
    if unmetered && benchmark_path == "" {

        return error("unmetered execution is limited to the development benchmark")
    }
    if renderer_choice != "cpu" && renderer_choice != "gpu" && renderer_choice != "auto" {
        return error("renderer must be cpu, gpu or auto")
    }
    if ssaa != "off" &&
       ssaa != "2x" &&
       ssaa != "1080p" { return error("SSAA must be off, 2x or 1080p") }
    if renderer_choice == "cpu" &&
       resident_meshes { return error("Resident meshes require the GPU renderer") }
    startup_start := clock_ms()
    baseline_working, _ := process_memory()
    file_bytes, read_error := read_bounded(game_path, cartridge.MAX_BYTES)
    if read_error != "" {

        return error(read_error)
    }
    defer delete(file_bytes)
    bytes := file_bytes
    source: []u8
    executor_bytes, source_owned: []u8
    defer delete(executor_bytes)
    defer delete(source_owned)
    cart: cartridge.Cartridge
    packaged := cartridge.is_png(bytes) || strings.has_suffix(strings.to_lower(game_path), ".png")
    if packaged {
        if source_path != "" {

            return error("PNG cartridges cannot use an external source file")
        }
        parse_error: string
        cart, parse_error = cartridge.parse(bytes)
        if parse_error != "" {

            return error(parse_error)
        }
        if cart.language == cartridge.LUAU {
            source = cart.code
            executor_error: string
            executor_bytes, executor_error = read_bounded(executor_path, abi.MAX_GAME_BYTES)
            if executor_error != "" {

                return error("cannot load player-supplied Luau executor")
            }
            bytes = executor_bytes
        } else {

            bytes = cart.code
        }
    } else if source_path != "" {
        source_error: string
        source_owned, source_error = read_bounded(source_path, 256 * 1024)
        if source_error != "" {

            return error(source_error)
        }
        source = source_owned
    }
    if len(source) > 0 && !no_executor_cache && cache_config == "" {
        directory := fmt.tprintf("%sexecutor-cache", base)
        if !guest.ensure_directory(directory) {

            return error("cannot create executor cache directory")
        }
        cache_config = fmt.tprintf("%sexecutor-cache.toml", base)
        config_text := fmt.tprintf(
            "[cache]\ndirectory = %q\nfiles-total-size-soft-limit = \"64Mi\"\n",
            directory,
        )
        if os.write_entire_file(cache_config, config_text) != nil {

            return error("cannot write executor cache configuration")
        }
    }
    if no_executor_cache {

        cache_config = ""
    }
    if !guest.load(
        &app.game,
        bytes,
        source,
        !unmetered,
        cache_config,
        cart.profile,
        cart.content,
        file_bytes if packaged || len(source) == 0 else source,
        cart.save_id,
        cart.save_legacy,
    ) {

        return error(app.game.error)
    }
    if packaged && !guest.validate_sdk(&app.game, cart.sdk) {

        return error(app.game.error)
    }
    core.init()
    if renderer_choice != "cpu" {
        quality := 6 if ssaa == "1080p" else 2 if ssaa == "2x" else 1
        if gpu.open(quality, surface_samples) {
            app.gpu_enabled = true
            app.game.resources.rasterizer = gpu.raster
            app.game.resources.frame_device = gpu.frame
            app.game.resources.deferred_raster = true
            app.game.resources.pixel_snap = pixel_snap
            app.game.resources.smooth_pan = smooth_pan
            app.game.resources.resident_meshes = resident_meshes
            fmt.eprintln("graphics: GPU rasterization enabled")
        } else if renderer_choice == "gpu" {
            return error("cannot initialize OpenGL 3.3 GPU renderer")
        } else {
            gpu.close()
            fmt.eprintln("graphics: GPU unavailable; using CPU renderer")
        }
    }
    if surface_samples && !app.gpu_enabled {
        return error("Whole-scene surface samples require an available GPU renderer")
    }
    if !app.gpu_enabled && (ssaa != "off" || pixel_snap || smooth_pan) {
        resources.software_configure(6 if ssaa == "1080p" else 2 if ssaa == "2x" else 1)
        app.game.resources.rasterizer = resources.software_raster
        app.game.resources.deferred_raster = true
        app.game.resources.pixel_snap = pixel_snap
        app.game.resources.smooth_pan = smooth_pan
        app.game.resources.resident_meshes = false
    }
    asset_size, graphics_ok := guest.read_graphics(&app.game)
    if !graphics_ok {

        return error(app.game.error)
    }
    if asset_size > 0 && !core.load_graphics(app.game.assets[:asset_size]) {

        return error("invalid graphics assets")
    }
    if !draw(app) {

        return error(app.game.error)
    }
    if packaged && app.game.display_mode != cart.display {

        return error("cartridge initial display does not match its metadata")
    }
    if benchmark_path != "" {

        return benchmark(
            app,
            benchmark_path,
            clock_ms() - startup_start,
            baseline_working,
            benchmark_warmup,
        )
    }
    if replay_path != "" {
        data, replay_error := os.read_entire_file(replay_path, context.allocator)
        if replay_error != nil {

            return error("cannot read input replay")
        }
        defer delete(data)
        for field in strings.fields(string(data)) {
            replay_input, ok := abi.parse_input(field)
            if !ok {

                return error("invalid input replay")
            }
            if !guest.update(&app.game, replay_input) || !draw(app) {

                return error(app.game.error)
            }
            if !guest.materialize_graphics(&app.game) { return error(app.game.error) }
            fmt.printf("{{\"hash\":%d,\"sounds\":%d}}\n", core.hash(), app.frame.sounds)
        }
        if raw_capture != "" {
            pixels := (cast([^]u8)&core.pixels[0])[:core.width * core.height * 4]
            if os.write_entire_file(raw_capture, pixels) !=
               nil { return error("cannot save replay RGBA capture") }
        }
        return 0
    }

    if !check_only {
        if !sdl.Init({.VIDEO, .AUDIO, .GAMEPAD}) {

            return error(string(sdl.GetError()))
        }
        title := branding.PLAYER_TITLE
        if packaged {

            title = cart.title
        }
        app.title_base = title
        if app.gpu_enabled {
            app.window = gpu.show(
                strings.clone_to_cstring(title, context.temp_allocator),
                core.width * 2,
                core.height * 2,
                render_fps == timing.NATIVE_FRAME_RATE,
            )
            app.gpu_window = true
        } else {
            app.window = sdl.CreateWindow(
                strings.clone_to_cstring(title, context.temp_allocator),
                i32(core.width * 2),
                i32(core.height * 2),
                {.RESIZABLE},
            )
        }
        if app.window == nil {

            return error(string(sdl.GetError()))
        }
        if !app.gpu_enabled {
            app.renderer = sdl.CreateRenderer(app.window, nil)
            if app.renderer == nil {

                return error(string(sdl.GetError()))
            }
            _ = sdl.SetRenderVSync(
                app.renderer,
                1 if render_fps == timing.NATIVE_FRAME_RATE else 0,
            )
            if !display_texture(app) {

                return error(string(sdl.GetError()))
            }
        }
        spec := sdl.AudioSpec {
            format   = .F32,
            channels = 1,
            freq     = core.SAMPLE_RATE,
        }
        app.audio = sdl.OpenAudioDeviceStream(sdl.AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, nil, nil)
        if app.audio == nil || !sdl.ResumeAudioStreamDevice(app.audio) {

            return error(string(sdl.GetError()))
        }
        pad_count: i32
        pads := sdl.GetGamepads(&pad_count)
        if pad_count > 0 {

            app.gamepad = sdl.OpenGamepad(pads[0])
        }
        sdl.free(pads)
    }

    app.focused = true
    running := true
    previous := f64(sdl.GetTicksNS()) / 1e9
    clock: timing.Clock
    for running {
        sync_text_input(app)
        event: sdl.Event
        if !check_only {
            for sdl.PollEvent(&event) {
                text_event(app, &event)
                #partial switch event.type {
                case .QUIT:
                    running = false
                case .RENDER_DEVICE_LOST, .RENDER_DEVICE_RESET, .RENDER_TARGETS_RESET:
                    return error("display context lost; restart the player")
                case .KEY_DOWN:
                    if event.key.scancode == .F11 && !event.key.repeat {

                        _ = sdl.SetWindowFullscreen(
                            app.window,
                            !(.FULLSCREEN in sdl.GetWindowFlags(app.window)),
                        )
                    }
                case .WINDOW_FOCUS_LOST:
                    app.game.text_input.composing = false
                    abi.text_finish(&app.game.text_input, true)
                    app.focused = false; clock = {}
                    app.wheel = 0
                case .WINDOW_FOCUS_GAINED:
                    app.focused = true; clock = {}
                case .MOUSE_WHEEL:
                    if app.focused {
                        direction: i32 = 1
                        if event.wheel.direction == .FLIPPED { direction = -1 }
                        if event.wheel.y > 0 { app.wheel = direction }
                        if event.wheel.y < 0 { app.wheel = -direction }
                    }
                case .GAMEPAD_ADDED:
                    if app.gamepad == nil {

                        app.gamepad = sdl.OpenGamepad(event.gdevice.which)
                    }
                case .GAMEPAD_REMOVED:
                    if app.gamepad != nil && sdl.GetGamepadID(app.gamepad) == event.gdevice.which {
                        sdl.CloseGamepad(app.gamepad)
                        app.gamepad = nil
                    }
                }
            }
        }
        now := f64(sdl.GetTicksNS()) / 1e9
        delta := clamp(now - previous, 0, 0.1)
        previous = now
        if smoke || check_only {
            timing.advance(&clock, 1.0 / timing.SIMULATION_HZ)
        } else if app.focused {
            timing.advance(&clock, delta)
        }
        steps, render := timing.take(&clock, render_fps)
        if smoke || check_only { render = true }
        if !app.focused && !smoke && !check_only { render = false }
        for _ in 0 ..< steps {
            keys: abi.Input
            if smoke || check_only {

                keys = abi.smoke_input(app.frame.ticks)
            } else {

                keys = input(app)
            }
            if !guest.update(&app.game, keys) {

                return error(app.game.error)
            }
            sync_text_input(app)
        }
        // Draws may run without an update, or after multiple fixed updates.
        if render && !draw(app) { return error(app.game.error) }
        if !check_only {
            if !guest.pump_ogg(&app.game) { return error(app.game.error) }
            if !attach_audio(app) { return error("cannot start PCM mixer output") }
            mixer.pause(app.audio_engine, !app.focused)
            if app.audio_paused != !app.focused {
                app.audio_paused = !app.focused
                if app.mixer_audio != nil {
                    _ = sdl.ClearAudioStream(app.mixer_audio)
                }
            }
            mixer.reclaim(app.audio_engine)
            if app.frame.sounds != app.sounds_played {
                _ = sdl.ClearAudioStream(app.audio)
                if !sdl.PutAudioStreamData(app.audio, &core.sample, size_of(core.sample)) {

                    return error(string(sdl.GetError()))
                }
                app.audio_queued += core.SAMPLE_COUNT
                app.sounds_played = app.frame.sounds
            }
            if !render {
                sdl.Delay(1)
                continue
            }
            if app.gpu_enabled {
                w, h: i32
                if !sdl.GetWindowSizeInPixels(app.window, &w, &h) ||
                   !gpu.present(
                           &app.game.resources,
                           core.pixels[:core.width * core.height],
                           core.width,
                           core.height,
                           int(w),
                           int(h),
                           true,
                       ) {
                    return error("GPU presentation failed")
                }
            } else if !display_texture(app) ||
               !sdl.UpdateTexture(
                       app.texture,
                       nil,
                       raw_data(app.present_pixels),
                       i32(app.presenter.width * 4),
                   ) ||
               !sdl.SetRenderDrawColor(app.renderer, 0, 0, 0, 255) ||
               !sdl.RenderClear(app.renderer) ||
               !sdl.RenderTexture(app.renderer, app.texture, nil, nil) ||
               !sdl.RenderPresent(app.renderer) {
                return error(string(sdl.GetError()))
            }
            update_window_stats(app, true)
        }
        if (smoke || check_only) && app.frame.ticks >= 120 {

            running = false
        }
    }
    if !guest.materialize_graphics(&app.game) { return error(app.game.error) }
    if capture != "" && !check_only {
        surface := sdl.CreateSurfaceFrom(
            i32(core.width),
            i32(core.height),
            .RGBA32,
            &core.pixels,
            i32(core.width * 4),
        )
        if surface == nil {

            return error(string(sdl.GetError()))
        }
        saved := sdl.SaveBMP(surface, strings.clone_to_cstring(capture, context.temp_allocator))
        sdl.DestroySurface(surface)
        if !saved {

            return error(string(sdl.GetError()))
        }
    }
    // The audio device thread can start after the 120 headless ticks finish, so the smoke report
    // would otherwise race it on macOS. Give the first PCM callback a bounded time to arrive.
    if smoke && app.game.resources.audio != nil {
        for _ in 0 ..< 200 {
            if mixer.load(&app.game.resources.audio.published_frame) > 0 { break }
            sdl.Delay(10)
        }
    }
    // Double braces escape Odin's formatting syntax in the JSON report.
    fmt.printf(
        "{{\"ticks\":%d,\"sounds\":%d,\"hash\":%d,\"spriteX\":%d,\"spriteY\":%d,\"audioQueuedFrames\":%d,\"resourceHash\":%d,\"resourceBytes\":%d",
        app.frame.ticks,
        app.frame.sounds,
        core.hash(),
        app.frame.sprite_x,
        app.frame.sprite_y,
        app.audio_queued,
        guest.resource_hash(&app.game),
        app.game.resources.bytes,
    )
    if app.game.resources.audio != nil {
        fmt.printf(
            " ,\"audioMixerFrame\":%d",
            mixer.load(&app.game.resources.audio.published_frame),
        )
    }
    fmt.println("}")
    return 0
}

main :: proc() {
    status := run()
    if status != 0 {

        os.exit(status)
    }
}
