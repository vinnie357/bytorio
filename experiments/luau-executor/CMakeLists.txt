cmake_minimum_required(VERSION 3.24)
project(luau_executor_prototype LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(LUAU_BUILD_CLI OFF CACHE BOOL "" FORCE)
set(LUAU_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LUAU_BUILD_WEB OFF CACHE BOOL "" FORCE)
include(FetchContent)
FetchContent_Declare(luau GIT_REPOSITORY https://github.com/luau-lang/luau.git GIT_TAG 9d7748a4f324213a18cb8283fa2a77c330225fa0)
FetchContent_MakeAvailable(luau)
add_executable(luau_executor executor.cpp capabilities.cpp resource_transport.cpp)
target_link_libraries(luau_executor PRIVATE Luau.Compiler Luau.VM)
foreach(component luau_executor Luau.VM Luau.Compiler Luau.Ast Luau.Bytecode Luau.Common)
    target_compile_options(${component} PRIVATE -O3 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0 -ffile-prefix-map=${CMAKE_SOURCE_DIR}=prototype)
endforeach()
set_target_properties(luau_executor PROPERTIES OUTPUT_NAME "luau-executor" SUFFIX ".wasm")
target_link_options(luau_executor PRIVATE -O3 -fwasm-exceptions --no-entry
    -sSTANDALONE_WASM=1 -sWASM_LEGACY_EXCEPTIONS=0 -sFILESYSTEM=0
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4194304 -sMAXIMUM_MEMORY=33554432
    -sSTACK_SIZE=262144 -sMALLOC=emmalloc -sERROR_ON_UNDEFINED_SYMBOLS=1)
