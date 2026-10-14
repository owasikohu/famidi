import importlib.util
from pathlib import Path
import unittest

from py65.devices.mpu6502 import MPU

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gen_rom", ROOT / "tools/gen_rom.py")
gen_rom = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen_rom)


class NesMemory:
    def __init__(self, rom):
        self.rom = rom
        self.ram = bytearray(0x8000)
        self.writes = []

    def __getitem__(self, address):
        return self.rom[address & 255] if address >= 0x8000 else self.ram[address]

    def __setitem__(self, address, value):
        if address >= 0x8000:
            raise AssertionError("The PoC must never write to PRG ROM")
        self.ram[address] = value
        self.writes.append((address, value))


class RomTest(unittest.TestCase):
    def setUp(self):
        self.rom, self.listing, self.labels = gen_rom.assemble((ROOT / "rom/pulse.s").read_text())

    def test_mirroring_and_vectors(self):
        memory = NesMemory(self.rom)
        self.assertEqual(len(self.rom), 256)
        for address in range(0x8000, 0x10000):
            self.assertEqual(memory[address], self.rom[address & 255])
        cpu = MPU(memory=memory, pc=None)
        self.assertEqual(cpu.pc, self.labels["reset"])
        for vector in (0xFFFA, 0xFFFE):
            self.assertEqual(memory[vector] | memory[vector + 1] << 8, self.labels["interrupt"])

    def test_reset_apu_writes_and_endless_loop(self):
        memory = NesMemory(self.rom)
        cpu = MPU(memory=memory, pc=None)
        for _ in range(1000):
            cpu.step()
        self.assertEqual(cpu.pc, self.labels["forever"])
        self.assertEqual(cpu.sp, 255)
        self.assertTrue(cpu.p & cpu.INTERRUPT)
        self.assertFalse(cpu.p & cpu.DECIMAL)
        self.assertEqual(memory.writes, [
            (0x2000, 0), (0x2001, 0), (0x4010, 0), (0x4015, 0),
            (0x4017, 0x40), (0x4015, 1), (0x4000, 0xBF),
            (0x4001, 8), (0x4002, 0xFD), (0x4003, 8),
        ])
        period = memory[0x4002] | (memory[0x4003] & 7) << 8
        frequency = (21_477_272 / 12) / (16 * (period + 1))
        self.assertAlmostEqual(frequency, 440.397, places=3)
        # py65 checks the CPU program and MMIO writes, not audible APU output.

    def test_rom_overflow_and_overlap_rejected(self):
        for source in (".org $80ff\nlda #$ff", ".org $8000\nsei\n.org $8000\ncld"):
            with self.assertRaises(ValueError):
                gen_rom.assemble(source)


if __name__ == "__main__":
    unittest.main()
