.DEFAULT_GOAL := build

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PICO_SDK_PATH ?= $(ROOT)/build-tools/pico-sdk
PICO_TOOLCHAIN_PATH ?= $(ROOT)/build-tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi/bin
PYTHON ?= $(ROOT)/build-test-env/bin/python
PICOTOOL ?= $(ROOT)/build-tools/picotool/bin/picotool
PICOTOOL_CMAKE_DIR ?= $(ROOT)/build-tools/picotool/lib/cmake/picotool
JOBS ?= 4

export PATH := $(PICO_TOOLCHAIN_PATH):$(PATH)

CMAKE_ARGS = -G Ninja -DPICO_BOARD=pico2 -DPICO_PLATFORM=rp2350-arm-s \
	-DCMAKE_BUILD_TYPE=Release -DPICO_SDK_PATH="$(PICO_SDK_PATH)" \
	-DPICO_TOOLCHAIN_PATH="$(PICO_TOOLCHAIN_PATH)" \
	-DPython3_EXECUTABLE="$(PYTHON)" -Dpicotool_DIR="$(PICOTOOL_CMAKE_DIR)"

.PHONY: build build-c build-asm build-midi test timing check check-midi info info-midi flash-c flash-asm flash-midi web web-test

build: build-c build-asm

build-c:
	cmake -S "$(ROOT)" -B "$(ROOT)/build-c" $(CMAKE_ARGS) -DFAMIDI_ASM=OFF -DFAMIDI_USB_MIDI=OFF
	cmake --build "$(ROOT)/build-c" -j$(JOBS)

build-asm:
	cmake -S "$(ROOT)" -B "$(ROOT)/build-asm" $(CMAKE_ARGS) -DFAMIDI_ASM=ON -DFAMIDI_USB_MIDI=OFF
	cmake --build "$(ROOT)/build-asm" -j$(JOBS)

build-midi:
	cmake -S "$(ROOT)" -B "$(ROOT)/build-midi" $(CMAKE_ARGS) -DFAMIDI_ASM=ON -DFAMIDI_USB_MIDI=ON
	cmake --build "$(ROOT)/build-midi" -j$(JOBS)

test:
	cd "$(ROOT)" && "$(PYTHON)" -m unittest discover -s tests -v

timing: build
	"$(PYTHON)" "$(ROOT)/tools/analyze_timing.py" \
		--c "$(ROOT)/build-c/famidi.elf" --asm "$(ROOT)/build-asm/famidi.elf" \
		--out "$(ROOT)/build-evidence"

check: test timing
	"$(PYTHON)" "$(ROOT)/tools/check_arm_loop.py" \
		--c "$(ROOT)/build-c/famidi.elf" --asm "$(ROOT)/build-asm/famidi.elf"

check-midi: test build build-midi
	"$(PYTHON)" "$(ROOT)/tools/check_arm_loop.py" \
		--c "$(ROOT)/build-c/famidi.elf" --asm "$(ROOT)/build-asm/famidi.elf" \
		--midi "$(ROOT)/build-midi/famidi.elf"
	"$(PYTHON)" "$(ROOT)/tools/analyze_timing.py" \
		--c "$(ROOT)/build-c/famidi.elf" --asm "$(ROOT)/build-asm/famidi.elf" \
		--midi "$(ROOT)/build-midi/famidi.elf" --out "$(ROOT)/build-evidence-midi"
	"$(PYTHON)" "$(ROOT)/tools/check_midi_firmware.py" \
		--baseline "$(ROOT)/build-asm/famidi.elf" --midi "$(ROOT)/build-midi/famidi.elf"

info: build
	"$(PICOTOOL)" info -a "$(ROOT)/build-c/famidi.uf2"
	"$(PICOTOOL)" info -a "$(ROOT)/build-asm/famidi.uf2"

info-midi: build-midi
	"$(PICOTOOL)" info -a "$(ROOT)/build-midi/famidi.uf2"

# NES off; connect Pico 2 in BOOTSEL mode before running a flash target.
flash-c: check
	"$(PICOTOOL)" load -v -x "$(ROOT)/build-c/famidi.uf2"

flash-asm: check
	"$(PICOTOOL)" load -v -x "$(ROOT)/build-asm/famidi.uf2"

flash-midi: check-midi
	"$(PICOTOOL)" load -v -x "$(ROOT)/build-midi/famidi.uf2"

web:
	python3 -m http.server 8080 --bind 127.0.0.1 --directory "$(ROOT)/web-midi/dist"

web-test:
	cd "$(ROOT)/web-midi" && npm test
