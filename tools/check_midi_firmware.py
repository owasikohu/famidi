#!/usr/bin/env python3
"""Verify the MIDI firmware keeps the exact linked ASM polling bytes."""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS, UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.arm_const import (UC_CPU_ARM_CORTEX_M33, UC_ARM_REG_R0, UC_ARM_REG_R1,
                              UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_LR,
                              UC_ARM_REG_PC, UC_ARM_REG_SP, UC_ARM_REG_PRIMASK)


def check_startup(args, symbols):
    """Execute linked boot code, stubbing PLL setup and the ROM launch handshake.

    This checks core assignment, the ACTUAL MSP switch and all GPIO setup writes.
    It does not emulate USB hardware or claim physical timing.
    """
    addresses = {line.split()[-1]: int(line.split()[0], 16)
                 for line in symbols.splitlines() if len(line.split()) >= 3}
    cpu = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
    cpu.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M33)
    for base, size in ((0x10000000, 0x100000), (0x20000000, 0x82000),
                       (0x40000000, 0x100000), (0xd0000000, 0x1000), (0xe000e000, 0x2000)):
        cpu.mem_map(base, size)
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "text.bin"
        subprocess.run([args.objcopy, "-O", "binary", "--only-section=.text",
                        str(args.midi), str(output)], check=True)
        cpu.mem_write(0x10000000, output.read_bytes())
    phase, reached, writes = ["usb"], set(), []

    def hook(uc, address, size, user):
        if address == addresses["check_sys_clock_khz"]:
            for reg in (UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3):
                uc.mem_write(uc.reg_read(reg), (1).to_bytes(4, "little"))
            uc.reg_write(UC_ARM_REG_R0, 1)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif address == addresses["set_sys_clock_pll"]:
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif address == addresses["multicore_launch_core1_with_stack"]:
            assert uc.reg_read(UC_ARM_REG_R0) == addresses["famidi_rom_core1"] | 1
            assert uc.reg_read(UC_ARM_REG_R1) == addresses["rom_stack"]
            assert uc.reg_read(UC_ARM_REG_R2) == 2048
            uc.mem_write(addresses["rom_ready"], b"\x01")
            reached.add("launched ROM on core 1")
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif phase[0] == "usb" and address == addresses["tusb_rhport_init"]:
            assert uc.reg_read(UC_ARM_REG_PRIMASK) == 0
            assert addresses["usb_stack"] < uc.reg_read(UC_ARM_REG_SP) <= addresses["usb_stack"] + 8192
            reached.add("USB on core 0 with normal-SRAM MSP and IRQs enabled")
            uc.emu_stop()
        elif phase[0] == "rom" and address == addresses["rom_poll_arm"]:
            assert uc.reg_read(UC_ARM_REG_PRIMASK) == 1
            assert uc.reg_read(UC_ARM_REG_R0) == addresses["rom256"]
            assert addresses["rom_stack"] <= uc.reg_read(UC_ARM_REG_SP) <= addresses["rom_stack"] + 2048
            reached.add("ROM loop on core 1 with IRQs disabled")
            uc.emu_stop()

    def write(uc, access, address, size, value, user):
        if address >= 0x40000000:
            writes.append((address, value))

    cpu.hook_add(UC_HOOK_CODE, hook)
    cpu.hook_add(UC_HOOK_MEM_WRITE, write)
    cpu.reg_write(UC_ARM_REG_SP, 0x20082000)
    cpu.emu_start(addresses["main"] | 1, 0, count=10000)
    assert len(reached) == 2, reached
    controls = {address for address, _ in writes if 0x40028000 <= address < 0x40028200}
    pads = {address for address, _ in writes if 0x40038004 <= address < 0x40038100}
    assert controls == {0x40028004 + 8 * gpio for gpio in range(18)}, controls
    assert pads == {0x40038004 + 4 * gpio for gpio in range(18)}, pads
    for address, value in writes:
        if address in (0xd0000038, 0xd0000040):
            assert value & ~0x3ffff == 0, (address, value)
    phase[0] = "rom"
    cpu.reg_write(UC_ARM_REG_PRIMASK, 0)
    cpu.reg_write(UC_ARM_REG_SP, addresses["rom_stack"] + 2048)
    cpu.emu_start(addresses["famidi_rom_core1"] | 1, 0, count=1000)
    assert len(reached) == 3, reached
    print("Linked startup: USB core 0 / ROM core 1; GPIO setup strictly GP0..17; MSP relocation validated")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--midi", required=True, type=Path)
    parser.add_argument("--objcopy", default="arm-none-eabi-objcopy")
    parser.add_argument("--objdump", default="arm-none-eabi-objdump")
    parser.add_argument("--nm", default="arm-none-eabi-nm")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as directory:
        code = []
        for name, elf in (("baseline", args.baseline), ("midi", args.midi)):
            output = Path(directory) / name
            subprocess.run([args.objcopy, "-O", "binary", "--only-section=.scratch_x",
                            str(elf), str(output)], check=True)
            code.append(output.read_bytes())
        if not code[0] or code[0] != code[1]:
            raise SystemExit("MIDI build changed the linked ASM polling bytes")
    symbols = subprocess.check_output([args.nm, "-S", str(args.midi)], text=True)
    for name, minimum in (("usb_stack", 8192), ("rom_stack", 2048)):
        match = re.search(rf"^([0-9a-f]+) ([0-9a-f]+) \w {name}$", symbols, re.M)
        if not match:
            raise SystemExit(f"Missing dedicated {name}")
        address, size = (int(value, 16) for value in match.groups())
        if not 0x20000000 <= address < address + size <= 0x20080000 or size < minimum:
            raise SystemExit(f"{name} must use normal SRAM, outside polling/ROM banks")
    for symbol, instruction in (("famidi_rom_core1", "cpsid"), ("famidi_usb_main", "cpsie")):
        disassembly = subprocess.check_output(
            [args.objdump, "-d", f"--disassemble={symbol}", str(args.midi)], text=True)
        if not re.search(rf"\b{instruction}\s+i\b", disassembly):
            raise SystemExit(f"{symbol}: missing {instruction} i")
    print(f"MIDI polling: identical to baseline ({len(code[0])} bytes including literals)")
    check_startup(args, symbols)


if __name__ == "__main__":
    main()
