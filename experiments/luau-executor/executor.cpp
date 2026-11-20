// PROTOTYPE: a player-supplied Luau compiler/VM behind the cartridge ABI.
#include "console_constants.h"
#include "resource_transport.h"
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <lua.h>
#include <luacode.h>
#include <lualib.h>

extern "C" __attribute__((import_module("env"), import_name("content_size"))) std::uint32_t
host_content_size(std::uint32_t id);
extern "C" __attribute__((import_module("env"), import_name("content_read"))) std::uint32_t
host_content_read(std::uint32_t id, std::uint32_t offset, void* destination, std::uint32_t length);
extern "C" __attribute__((import_module("env"), import_name("save_size"))) std::uint32_t
host_save_size();
extern "C" __attribute__((import_module("env"), import_name("save_status"))) std::uint32_t
host_save_status();
extern "C" __attribute__((import_module("env"), import_name("save_read"))) std::uint32_t
host_save_read(void* destination, std::uint32_t capacity);
extern "C" __attribute__((import_module("env"), import_name("save_write"))) std::uint32_t
host_save_write(const void* source, std::uint32_t length);
extern "C" __attribute__((import_module("env"), import_name("text_configure"))) std::uint32_t
host_text_configure(const void* source, std::uint32_t length);
extern "C" __attribute__((import_module("env"), import_name("text_read"))) std::uint32_t
host_text_read(void* destination, std::uint32_t capacity);

namespace {
using namespace console_constants;

struct Frame {
    std::uint32_t version, clear;
    std::int32_t sprite_x, sprite_y;
    std::uint32_t ticks, sounds;
    double x, y;
};

struct Command {
    std::uint32_t kind;
    std::int32_t x, y, w, h;
    std::uint32_t color, offset, length;
};

static_assert(sizeof(Frame) == 40 && offsetof(Frame, x) == 24);
static_assert(sizeof(Command) == 32);
constexpr std::size_t source_capacity = MAX_LUAU_SOURCE_BYTES, heap_limit = MAX_LUAU_HEAP_BYTES,
                      max_commands = MAX_COMMANDS;
char* source;
std::size_t source_reserved;
char error[1024];
std::uint32_t source_size, buttons, command_count;
bool pointer_active;
double pointer_x, pointer_y;
std::size_t heap_bytes, peak_heap_bytes;
Command commands[max_commands];
constexpr std::size_t max_assets = MAX_GRAPHICS_BYTES, max_text = MAX_TEXT_BYTES;
unsigned char assets[max_assets], text[max_text];
std::uint32_t assets_size, text_size;
Frame frame;
constexpr unsigned display_dimension_bits = 16;
constexpr std::uint32_t display_dimension_mask = (1u << display_dimension_bits) - 1;
std::uint32_t display_mode = (640u << display_dimension_bits) | 360u;

int display(lua_State* L) {
    const double w = luaL_checknumber(L, 1), h = luaL_checknumber(L, 2);
    if (!((w == 640 && h == 360) || (w == 320 && h == 180)))
        luaL_error(L, "unsupported display mode");
    display_mode = (std::uint32_t(w) << display_dimension_bits) | std::uint32_t(h);
    return 0;
}

lua_State* state;
int module = -1;

void fail(const char* message) {
    std::snprintf(error, sizeof(error), "%s", message ? message : "Luau callback failed");
}

void* allocate(void*, void* ptr, std::size_t old_size, std::size_t size) {
    const auto previous = ptr ? old_size : 0;
    if (!size) {
        heap_bytes -= previous;
        std::free(ptr);
        return nullptr;
    }
    const auto retained = heap_bytes - previous;
    if (size > heap_limit || retained > heap_limit - size)
        return nullptr;
    void* result = std::realloc(ptr, size);
    if (result) {
        heap_bytes = retained + size;
        peak_heap_bytes = std::max(heap_bytes, peak_heap_bytes);
    }
    return result;
}

int integer(lua_State* L, int arg, int low, int high) {
    const double value = luaL_checknumber(L, arg);
    if (!std::isfinite(value) || value < low || value > high)
        luaL_argerror(L, arg, "value outside supported range");
    return static_cast<int>(value);
}

int clear(lua_State* L) {
    const auto r = integer(L, 1, 0, 255), g = integer(L, 2, 0, 255), b = integer(L, 3, 0, 255);
    frame.clear = COLOR_OPAQUE_BLACK | (static_cast<std::uint32_t>(b) << 16U) |
                  (static_cast<std::uint32_t>(g) << 8U) | static_cast<std::uint32_t>(r);
    return 0;
}

int rect(lua_State* L) {
    const auto x = integer(L, 1, COORDINATE_MIN, COORDINATE_MAX),
               y = integer(L, 2, COORDINATE_MIN, COORDINATE_MAX),
               w = integer(L, 3, 0, COORDINATE_MAX), h = integer(L, 4, 0, COORDINATE_MAX);
    const double color = luaL_checknumber(L, 5);
    if (!std::isfinite(color) || color < 0 || color > U32_MAX)
        luaL_argerror(L, 5, "invalid RGBA color");
    if (w == 0 || h == 0 || x >= int(display_mode >> display_dimension_bits) ||
        y >= int(display_mode & display_dimension_mask) || x + w <= 0 || y + h <= 0)
        return 0;
    if (command_count == max_commands)
        luaL_error(L, "display list limit exceeded");
    commands[command_count++] = {0, x, y, w, h, static_cast<std::uint32_t>(color), 0, 0};
    return 0;
}

int graphics_assets(lua_State* L) {
    std::size_t size;
    const auto* encoded = luaL_checklstring(L, 1, &size);
    if (size > max_assets * 4 / 3 + 4)
        luaL_error(L, "graphics assets too large");
    assets_size = 0;
    std::uint32_t bits = 0;
    int count = 0;
    for (std::size_t i = 0; i < size; i++) {
        const char c = encoded[i];
        if (c == '=') {
            for (; i < size; i++)
                if (encoded[i] != '=')
                    luaL_error(L, "invalid graphics encoding");
            break;
        }
        int value = c >= 'A' && c <= 'Z'   ? c - 'A'
                    : c >= 'a' && c <= 'z' ? c - 'a' + 26
                    : c >= '0' && c <= '9' ? c - '0' + 52
                    : c == '+'             ? 62
                    : c == '/'             ? 63
                                           : -1;
        if (value < 0)
            luaL_error(L, "invalid graphics encoding");
        bits = (bits << 6U) | static_cast<unsigned>(value);
        count += 6;
        if (count >= 8) {
            count -= 8;
            if (assets_size == max_assets)
                luaL_error(L, "graphics assets too large");
            assets[assets_size++] =
                static_cast<unsigned char>(bits >> static_cast<unsigned>(count));
        }
    }
    return 0;
}

int draw_sprite(lua_State* L) {
    const int id = integer(L, 1, 0, 255), x = integer(L, 2, COORDINATE_MIN, COORDINATE_MAX),
              y = integer(L, 3, COORDINATE_MIN, COORDINATE_MAX), scale = integer(L, 4, 1, 8);
    if (command_count == max_commands)
        luaL_error(L, "display list limit exceeded");
    commands[command_count++] = {1, x, y, id, scale, 0, 0, 0};
    return 0;
}

int draw_sprite_size(lua_State* L) {
    const int id = integer(L, 1, 0, 255), x = integer(L, 2, COORDINATE_MIN, COORDINATE_MAX),
              y = integer(L, 3, COORDINATE_MIN, COORDINATE_MAX), w = integer(L, 4, 1, 128),
              h = integer(L, 5, 1, 128);
    if (command_count == max_commands)
        luaL_error(L, "display list limit exceeded");
    commands[command_count++] = {3, x, y, w, h, static_cast<std::uint32_t>(id), 0, 0};
    return 0;
}

int draw_text(lua_State* L) {
    std::size_t size;
    const char* value = luaL_checklstring(L, 1, &size);
    const int x = integer(L, 2, COORDINATE_MIN, COORDINATE_MAX),
              y = integer(L, 3, COORDINATE_MIN, COORDINATE_MAX);
    const double color = luaL_checknumber(L, 4);
    if (!std::isfinite(color) || color < 0 || color > U32_MAX)
        luaL_argerror(L, 4, "invalid RGBA color");
    if (command_count == max_commands || size > MAX_TEXT_BYTES_PER_COMMAND ||
        size > max_text - text_size)
        luaL_error(L, "text batch limit exceeded");
    std::memcpy(text + text_size, value, size);
    commands[command_count++] = {2,         x,
                                 y,         0,
                                 0,         static_cast<std::uint32_t>(color),
                                 text_size, static_cast<std::uint32_t>(size)};
    text_size += size;
    return 0;
}

int button(lua_State* L) {
    const char* name = luaL_checkstring(L, 1);
    unsigned mask = 0;
    if (!std::strcmp(name, "left"))
        mask = 1;
    else if (!std::strcmp(name, "right"))
        mask = 2;
    else if (!std::strcmp(name, "up"))
        mask = 4;
    else if (!std::strcmp(name, "down"))
        mask = 8;
    else if (!std::strcmp(name, "action"))
        mask = 16;
    else
        luaL_argerror(L, 1, "unknown button");
    lua_pushboolean(L, (buttons & mask) != 0);
    return 1;
}

int sound(lua_State*) {
    ++frame.sounds;
    return 0;
}

int input_buttons(lua_State* L) {
    lua_pushnumber(L, buttons);
    return 1;
}

std::uint32_t content_integer(lua_State* L, int argument) {
    const double value = luaL_checknumber(L, argument);
    if (!std::isfinite(value) || value < 0 || value > U32_MAX || std::floor(value) != value)
        luaL_argerror(L, argument, "expected unsigned 32-bit integer");
    return static_cast<std::uint32_t>(value);
}

int content_size(lua_State* L) {
    lua_pushnumber(L, host_content_size(content_integer(L, 1)));
    return 1;
}

int content_read(lua_State* L) {
    const auto id = content_integer(L, 1);
    const auto offset = content_integer(L, 2);
    std::size_t length = 0;
    void* destination = luaL_checkbuffer(L, 3, &length);
    const bool accepted =
        length <= MAX_CONTENT_READ_BYTES &&
        host_content_read(id, offset, destination, static_cast<std::uint32_t>(length)) == 1;
    lua_pushboolean(L, accepted);
    return 1;
}

int input_pointer(lua_State* L) {
    lua_pushboolean(L, pointer_active);
    lua_pushnumber(L, pointer_x);
    lua_pushnumber(L, pointer_y);
    return 3;
}

int save_size(lua_State* L) {
    lua_pushnumber(L, host_save_size());
    return 1;
}

int text_configure(lua_State* L) {
    std::size_t length = 0;
    const void* source = luaL_checkbuffer(L, 1, &length);
    lua_pushnumber(L, length <= TEXT_INPUT_HEADER_BYTES + TEXT_INPUT_MAX_BYTES
                          ? host_text_configure(source, static_cast<std::uint32_t>(length))
                          : 0);
    return 1;
}

int text_read(lua_State* L) {
    std::size_t length = 0;
    void* destination = luaL_checkbuffer(L, 1, &length);
    lua_pushnumber(L, length <= TEXT_INPUT_HEADER_BYTES + TEXT_INPUT_MAX_BYTES
                          ? host_text_read(destination, static_cast<std::uint32_t>(length))
                          : 0);
    return 1;
}

int save_status(lua_State* L) {
    lua_pushnumber(L, host_save_status());
    return 1;
}

int save_read(lua_State* L) {
    std::size_t length = 0;
    void* destination = luaL_checkbuffer(L, 1, &length);
    lua_pushnumber(L, length <= MAX_SAVE_BYTES
                          ? host_save_read(destination, static_cast<std::uint32_t>(length))
                          : 0);
    return 1;
}

int save_write(lua_State* L) {
    std::size_t length = 0;
    const void* source = luaL_checkbuffer(L, 1, &length);
    lua_pushnumber(L, length > 0 && length <= MAX_SAVE_BYTES
                          ? host_save_write(source, static_cast<std::uint32_t>(length))
                          : SAVE_ERROR);
    return 1;
}

int debug_position(lua_State* L) {
    const double x = luaL_checknumber(L, 1), y = luaL_checknumber(L, 2);
    if (!std::isfinite(x) || !std::isfinite(y) || x < COORDINATE_MIN || x > COORDINATE_MAX ||
        y < COORDINATE_MIN || y > COORDINATE_MAX)
        luaL_error(L, "invalid development position");
    frame.x = x;
    frame.y = y;
    return 0;
}

bool call(const char* name, bool delta = false) {
    if (!state || module < 0 || error[0])
        return false;
    lua_getref(state, module);
    lua_getfield(state, -1, name);
    lua_remove(state, -2);
    if (delta)
        lua_pushnumber(state, 1.0 / 60.0);
    if (lua_pcall(state, delta ? 1 : 0, 0, 0) != 0) {
        fail(lua_tostring(state, -1));
        lua_settop(state, 0);
        return false;
    }
    return true;
}
} // namespace

extern "C" {
static std::uint32_t profile = 1;

EMSCRIPTEN_KEEPALIVE std::uint32_t game_profile() {
    return profile;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_required_features() {
    if (profile == console_constants::PROFILE_OGG)
        return console_constants::OGG_FEATURES;
    if (profile == console_constants::PROFILE_EFFECTS_3D)
        return console_constants::EFFECTS_3D_FEATURES;
    if (profile == console_constants::PROFILE_ALPHA_3D)
        return console_constants::ALPHA_3D_FEATURES;
    if (profile == console_constants::PROFILE_TEXTURED_3D)
        return console_constants::TEXTURED_3D_FEATURES;
    if (profile == console_constants::PROFILE_3D)
        return console_constants::PREVIEW_3D_FEATURES;
    return profile == console_constants::PROFILE_RESOURCE ? console_constants::RESOURCE_FEATURES
                                                          : 0;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_abi() {
    if (profile == console_constants::PROFILE_OGG)
        return console_constants::RESOURCE_ABI_VERSION;
    if (profile == console_constants::PROFILE_EFFECTS_3D)
        return console_constants::RESOURCE_ABI_VERSION;
    if (profile == console_constants::PROFILE_ALPHA_3D)
        return console_constants::RESOURCE_ABI_VERSION;
    if (profile == console_constants::PROFILE_TEXTURED_3D)
        return console_constants::RESOURCE_ABI_VERSION;
    if (profile == console_constants::PROFILE_3D)
        return console_constants::RESOURCE_ABI_VERSION;
    return profile == console_constants::PROFILE_RESOURCE ? console_constants::RESOURCE_ABI_VERSION
                                                          : 1;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_sdk_version() {
    if (profile == console_constants::PROFILE_OGG)
        return console_constants::OGG_SDK;
    if (profile == console_constants::PROFILE_EFFECTS_3D)
        return console_constants::EFFECTS_3D_SDK;
    if (profile == console_constants::PROFILE_ALPHA_3D)
        return console_constants::ALPHA_3D_SDK;
    if (profile == console_constants::PROFILE_TEXTURED_3D)
        return console_constants::TEXTURED_3D_SDK;
    if (profile == console_constants::PROFILE_3D)
        return console_constants::PREVIEW_3D_SDK;
    return profile == console_constants::PROFILE_RESOURCE ? console_constants::RESOURCE_SDK_VERSION
                                                          : 256;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_frame_size() {
    return sizeof(Frame);
}

EMSCRIPTEN_KEEPALIVE char* game_source_allocate(std::uint32_t size) {
    if (!size || size > source_capacity) {
        fail("invalid Luau source allocation size");
        return nullptr;
    }
    if (size != source_reserved) {
        auto* buffer = static_cast<char*>(std::realloc(source, size));
        if (!buffer) {
            fail("cannot allocate Luau source buffer");
            return nullptr;
        }
        source = buffer;
        source_reserved = size;
        source_size = 0;
    }
    return source;
}

EMSCRIPTEN_KEEPALIVE char* game_source_buffer() {
    if (source_reserved < source_capacity)
        return game_source_allocate(source_capacity);
    return source;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_source_capacity() {
    return source_capacity;
}

EMSCRIPTEN_KEEPALIVE void game_source_size(std::uint32_t size) {
    if (!size || size > source_reserved) {
        source_size = 0;
        fail("invalid Luau source size");
        return;
    }
    source_size = size;
    constexpr char marker[] = "--!console-profile=";
    constexpr auto prefix = sizeof(marker) - 1;
    profile = 1;
    if (size >= prefix && std::memcmp(source, marker, prefix) == 0)
        profile = size > prefix + 1 && source[prefix] >= '1' && source[prefix] <= '9' &&
                          source[prefix + 1] == '\n'
                      ? static_cast<std::uint32_t>(source[prefix] - '0')
                      : 0;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_error_length() {
    if (resource_transport::error()[0])
        fail(resource_transport::error());
    return std::strlen(error);
}

EMSCRIPTEN_KEEPALIVE const char* game_error() {
    return error;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_heap_bytes() {
    return heap_bytes;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_heap_peak() {
    return peak_heap_bytes;
}

EMSCRIPTEN_KEEPALIVE void game_init() {
    resource_transport::begin(0, 0);
    if (state)
        lua_close(state);
    state = nullptr;
    module = -1;
    heap_bytes = peak_heap_bytes = 0;
    buttons = command_count = assets_size = text_size = 0;
    error[0] = 0;
    display_mode = (640u << display_dimension_bits) | 360u;
    pointer_active = false;
    pointer_x = pointer_y = 0;
    frame = {1, DEFAULT_CLEAR_COLOR, COORDINATE_MIN, COORDINATE_MIN, 0, 0, 0, 0};
    if (!source_size || source_size > source_reserved) {
        fail("invalid Luau source size");
        return;
    }
    state = lua_newstate(allocate, nullptr);
    if (!state) {
        fail("cannot allocate Luau VM");
        return;
    }
    luaL_openlibs(state);
    const luaL_Reg api[] = {{"profile",
                             [](lua_State* L) -> int {
                                 lua_pushinteger(L, static_cast<int>(profile));
                                 return 1;
                             }},
                            {"resource_audio_status", resource_transport::audio_status},
                            {"content_size", content_size},
                            {"content_read", content_read},
                            {"save_size", save_size},
                            {"save_status", save_status},
                            {"save_read", save_read},
                            {"text_configure", text_configure},
                            {"text_read", text_read},
                            {"save_write", save_write},
                            {"resource_results", resource_transport::results},
                            {"resource_session", resource_transport::session},
                            {"resource_emit", resource_transport::emit},
                            {"display", display},
                            {"clear", clear},
                            {"rect", rect},
                            {"button", button},
                            {"buttons", input_buttons},
                            {"pointer", input_pointer},
                            {"debug_position", debug_position},
                            {"sound", sound},
                            {"graphics_assets", graphics_assets},
                            {"draw_sprite", draw_sprite},
                            {"draw_sprite_size", draw_sprite_size},
                            {"draw_text", draw_text},
                            {nullptr, nullptr}};
    luaL_register(state, "console", api);
    lua_setreadonly(state, -1, true);
    lua_pop(state, 1);
    luaL_sandbox(state);
    luaL_sandboxthread(state);
    std::size_t size = 0;
    lua_CompileOptions options{};
    options.optimizationLevel = 2;
    options.debugLevel = 1;
    char* bytecode = luau_compile(source, source_size, &options, &size);
    if (!bytecode) {
        fail("source compilation failed");
        return;
    }
    const int status = luau_load(state, "main.luau", bytecode, size, 0);
    std::free(bytecode);
    if (status || lua_pcall(state, 0, 1, 0)) {
        fail(lua_tostring(state, -1));
        return;
    }
    if (!lua_istable(state, -1)) {
        fail("game module must return a table");
        return;
    }
    module = lua_ref(state, -1);
    lua_pop(state, 1);
    call("init");
    resource_transport::end();
}

EMSCRIPTEN_KEEPALIVE void game_update(std::uint32_t mask, std::uint32_t active, double x,
                                      double y) {
    resource_transport::begin(std::uint64_t(frame.ticks) + 1);
    buttons = mask;
    pointer_active = active != 0;
    pointer_x = x;
    pointer_y = y;
    if (call("update", true))
        ++frame.ticks;
    resource_transport::end();
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_display_mode() {
    return display_mode;
}

EMSCRIPTEN_KEEPALIVE const Frame* game_draw() {
    resource_transport::begin(frame.ticks, 2);
    command_count = text_size = 0;
    call("draw");
    resource_transport::end();
    return &frame;
}

EMSCRIPTEN_KEEPALIVE const Command* game_commands() {
    return commands;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_command_count() {
    return command_count;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_command_stride() {
    return sizeof(Command);
}

EMSCRIPTEN_KEEPALIVE const unsigned char* game_text() {
    return text;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_text_size() {
    return text_size;
}

EMSCRIPTEN_KEEPALIVE const unsigned char* game_assets() {
    return assets;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t game_assets_size() {
    return assets_size;
}
}
