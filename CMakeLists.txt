cmake_minimum_required(VERSION 3.13)

# Configure with -DPICO_SDK_PATH=/path/to/pico-sdk -DPICO_BOARD=pico2.
if(NOT PICO_SDK_PATH AND DEFINED ENV{PICO_SDK_PATH})
    set(PICO_SDK_PATH "$ENV{PICO_SDK_PATH}")
endif()
if(NOT PICO_SDK_PATH)
    message(FATAL_ERROR "Set PICO_SDK_PATH to pico-sdk 2.2.0 or newer")
endif()
set(PICO_BOARD pico2 CACHE STRING "Target board")
include(${PICO_SDK_PATH}/external/pico_sdk_import.cmake)
project(famidi C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()
if(NOT PICO_PLATFORM STREQUAL "rp2350-arm-s")
    message(FATAL_ERROR "This PoC and its assembly/timing analysis target RP2350 Cortex-M33 (rp2350-arm-s)")
endif()

find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(ROM_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated)
add_custom_command(
    OUTPUT ${ROM_DIR}/rom256.h ${ROM_DIR}/rom256.bin ${ROM_DIR}/famidi.nes ${ROM_DIR}/rom.lst
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/gen_rom.py
            --source ${CMAKE_CURRENT_SOURCE_DIR}/rom/pulse.s --out ${ROM_DIR}
    DEPENDS tools/gen_rom.py rom/pulse.s
    VERBATIM)
add_custom_target(rom_image DEPENDS ${ROM_DIR}/rom256.h)

option(FAMIDI_ASM "Use the compact Cortex-M33 polling loop" OFF)
add_executable(famidi src/main.c ${ROM_DIR}/rom256.h)
set_target_properties(famidi PROPERTIES LINKER_LANGUAGE C)
add_dependencies(famidi rom_image)
if(FAMIDI_ASM)
    target_sources(famidi PRIVATE src/poll_arm.S)
    target_compile_definitions(famidi PRIVATE FAMIDI_ASM=1)
endif()
target_include_directories(famidi PRIVATE ${ROM_DIR})
target_compile_options(famidi PRIVATE $<$<COMPILE_LANGUAGE:C>:-O3>)
set_source_files_properties(src/main.c PROPERTIES COMPILE_OPTIONS "-Wall;-Wextra;-Werror")
target_compile_definitions(famidi PRIVATE
    PICO_STDIO_USB=0 PICO_STDIO_UART=0 PICO_TIME_DEFAULT_ALARM_POOL_DISABLED=1
    SYS_CLK_HZ=150000000)
target_link_libraries(famidi pico_runtime hardware_clocks)
pico_enable_stdio_usb(famidi 0)
pico_enable_stdio_uart(famidi 0)
pico_add_extra_outputs(famidi)
