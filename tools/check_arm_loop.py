#!/usr/bin/env python3
"""Run both linked polling loops in Unicorn with mocked SIO registers.

Checks bus logic, register offsets, ROM contents and continuous-address updates.
Unicorn is an instruction emulator; its execution time is NOT RP2350 timing.
"""
import argparse
from pathlib import Path
import struct
import subprocess
import tempfile

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_R0

SIO = 0xD0000000
CODE = 0x20080000
ROM = 0x20081000
DATA_MASK = 0xFF00
INHIBIT_MASK = 1 << 18


def check(elf, symbol, objcopy, nm):
    with tempfile.TemporaryDirectory() as tmp:
        sections = {}
        for section in ("scratch_x", "scratch_y"):
            output = Path(tmp) / section
            subprocess.run([objcopy, "-O", "binary", f"--only-section=.{section}", str(elf), str(output)], check=True)
            sections[section] = output.read_bytes()
    symbols = subprocess.check_output([nm, str(elf)], text=True).splitlines()
    entry = next(int(line.split()[0], 16) for line in symbols if line.split()[-1] == symbol)
    rom = sections["scratch_y"]
    assert len(rom) == 256
    # First exercise back-to-back selected addresses, then all four control
    # combinations for every address (CE only/OE only must NEVER enable data).
    samples = [3 << 16] + list(range(256))
    samples += [(control << 16) | address for address in range(256) for control in range(4)]
    cpu = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
    cpu.mem_map(CODE, 8192)
    cpu.mem_write(CODE, sections["scratch_x"])
    cpu.mem_write(ROM, rom)
    cpu.mem_map(SIO, 4096)
    cpu.reg_write(UC_ARM_REG_R0, ROM)
    state = {"index": 0, "writes": [], "out": 0, "oe": INHIBIT_MASK}

    def read_hook(uc, access, address, size, value, user):
        if address != SIO + 4:
            raise AssertionError(f"Unexpected SIO read {address:#x}")
        assert size == 4
        index = state["index"]
        if index:
            pins = samples[index - 1]
            if pins & (3 << 16):
                assert state["writes"] == [(0x40, DATA_MASK)], state
                assert state["oe"] & DATA_MASK == 0
            else:
                expected = rom[pins & 255] << 8
                assert state["writes"] == [(0x10, expected), (0x38, DATA_MASK)], state
                assert state["out"] == expected
                assert state["oe"] & DATA_MASK == DATA_MASK
            assert state["oe"] & INHIBIT_MASK
        if index == len(samples):
            uc.emu_stop()
            return
        uc.mem_write(SIO + 4, struct.pack("<I", samples[index]))
        state["index"] += 1
        state["writes"] = []

    def write_hook(uc, access, address, size, value, user):
        assert size == 4
        offset = address - SIO
        state["writes"].append((offset, value))
        if offset == 0x10:
            state["out"] = value
        elif offset == 0x38:
            state["oe"] |= value
        elif offset == 0x40:
            state["oe"] &= ~value
        else:
            raise AssertionError(f"Unexpected SIO write {address:#x}")

    cpu.hook_add(UC_HOOK_MEM_READ, read_hook, begin=SIO, end=SIO + 4095)
    cpu.hook_add(UC_HOOK_MEM_WRITE, write_hook, begin=SIO, end=SIO + 4095)
    cpu.emu_start(entry | 1, 0, count=100_000)
    assert state["index"] == len(samples), "Loop did not finish all samples"
    print(f"{symbol}: {len(samples)} sampled bus states validated (instruction emulation only)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--c", type=Path, required=True)
    parser.add_argument("--asm", type=Path, required=True)
    parser.add_argument("--objcopy", default="arm-none-eabi-objcopy")
    parser.add_argument("--nm", default="arm-none-eabi-nm")
    args = parser.parse_args()
    check(args.c, "rom_poll_c", args.objcopy, args.nm)
    check(args.asm, "rom_poll_arm", args.objcopy, args.nm)


if __name__ == "__main__":
    main()
