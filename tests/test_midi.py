"""Exercise the real C MIDI engine and IRQ-free 6502 mailbox consumer."""
import ctypes as ct
import importlib.util
import random
from pathlib import Path
import subprocess
import tempfile
import unittest

from py65.devices.mpu6502 import MPU

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("midi_rom", ROOT / "tools/gen_rom.py")
assembler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembler)


class Command(ct.Structure):
    _fields_ = [("timer", ct.c_uint16), ("volume", ct.c_uint8),
                ("gate", ct.c_bool), ("retrigger", ct.c_bool),
                ("channel", ct.c_uint8), ("duty", ct.c_uint8),
                ("sweep", ct.c_uint8), ("noise", ct.c_uint8)]

    def __init__(self, timer=0, volume=0, gate=False, retrigger=False, channel=0, duty=2, sweep=8, noise=0):
        super().__init__(timer, volume, gate, retrigger, channel, duty, sweep, noise)


class Voice(ct.Structure):
    _fields_ = [(name, ct.c_uint8) for name in
                ("note", "velocity", "volume", "expression", "duty", "sweep_on",
                 "sweep_up", "sweep_time", "sweep_shift")] + [("bend", ct.c_uint16), ("gate", ct.c_bool)]


class Midi(ct.Structure):
    _fields_ = [("voices", Voice * 4), ("queue", Command * 64),
                ("head", ct.c_uint), ("count", ct.c_uint)]


class Link(ct.Structure):
    _fields_ = [("state", ct.c_int), ("active", Command), ("applied", Command * 4)]


class MidiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        library = Path(cls.directory.name) / "midi.so"
        subprocess.run(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
                        "-shared", "-fPIC", str(ROOT / "src/midi_engine.c"),
                        "-lm", "-o", str(library)], check=True)
        cls.lib = ct.CDLL(str(library))
        cls.lib.famidi_midi_init.argtypes = [ct.POINTER(Midi)]
        cls.lib.famidi_midi_packet.argtypes = [ct.POINTER(Midi), ct.POINTER(ct.c_uint8)]
        cls.lib.famidi_midi_packet.restype = ct.c_bool
        cls.lib.famidi_midi_panic.argtypes = [ct.POINTER(Midi)]
        cls.lib.famidi_note_timer.argtypes = [ct.c_uint8, ct.c_uint16]
        cls.lib.famidi_note_timer.restype = ct.c_uint16
        cls.lib.famidi_volume.argtypes = [ct.c_uint8, ct.c_uint8]
        cls.lib.famidi_volume.restype = ct.c_uint8
        cls.lib.famidi_level.argtypes = [ct.c_uint8, ct.c_uint8, ct.c_uint8]
        cls.lib.famidi_level.restype = ct.c_uint8
        cls.lib.famidi_link_init.argtypes = [ct.POINTER(Link)]
        cls.lib.famidi_link_poll.argtypes = [ct.POINTER(Link), ct.POINTER(Midi),
                                            ct.POINTER(ct.c_uint8), ct.c_uint32]
        cls.lib.famidi_build_writes.argtypes = [ct.POINTER(ct.c_uint8),
                                               ct.POINTER(Command), ct.POINTER(Command)]
        cls.lib.famidi_build_writes.restype = ct.c_size_t
        cls.base_rom, _, cls.labels = assembler.assemble((ROOT / "rom/midi.s").read_text())

    def setUp(self):
        self.midi = Midi()
        self.lib.famidi_midi_init(ct.byref(self.midi))
        self.rom = (ct.c_uint8 * 256).from_buffer_copy(self.base_rom)
        self.link = Link()
        self.lib.famidi_link_init(ct.byref(self.link))

    def send(self, status, first, second, header=None):
        packet = (ct.c_uint8 * 4)(status >> 4 if header is None else header,
                                  status, first, second)
        return self.lib.famidi_midi_packet(ct.byref(self.midi), packet)

    def poll(self, pins):
        self.lib.famidi_link_poll(ct.byref(self.link), ct.byref(self.midi), self.rom, pins)

    def command(self, index=-1):
        return self.midi.queue[(self.midi.head + (self.midi.count - 1 if index == -1 else index)) % 64]

    def program(self, command, applied=None):
        result = (ct.c_uint8 * 48)()
        size = self.lib.famidi_build_writes(result, ct.byref(command), ct.byref(applied or Command()))
        return bytes(result[:size])

    def test_usb_packet_validation_and_channel_filter(self):
        for packet in [(0x94, 69, 127, None), (0x90, 69, 127, 0x19),
                       (0x90, 69, 127, 0x08), (0x90, 128, 127, None),
                       (0x90, 69, 128, None), (0xB0, 1, 127, None),
                       (0xF8, 0, 0, 0x0F), (0xF0, 0, 0, 0x04)]:
            self.assertTrue(self.send(*packet))
        self.assertEqual(self.midi.count, 0)
        self.assertFalse(self.midi.voices[0].gate)

    def test_note_on_off_zero_velocity_and_last_note_priority(self):
        self.assertTrue(self.send(0x90, 60, 100))
        self.assertTrue(self.send(0x90, 69, 127))
        self.assertTrue(self.command().retrigger)
        self.assertEqual(self.command().timer, 253)
        self.send(0x80, 60, 127)  # stale Note Off cannot stop the newer note
        self.assertEqual(self.midi.count, 2)
        self.assertTrue(self.midi.voices[0].gate)
        self.send(0x90, 69, 0)
        self.assertFalse(self.command().gate)
        self.assertEqual(self.command().volume, 0)
        self.send(0x90, 69, 1)
        self.send(0x80, 69, 127)
        self.assertFalse(self.midi.voices[0].gate)

    def test_famimimidi_note_range_does_not_steal_current_note(self):
        self.send(0x90, 69, 127)
        for note in (0, 32, 109, 127):
            self.send(0x90, note, 127)
        self.assertEqual(self.midi.count, 1)
        self.assertEqual(self.midi.voices[0].note, 69)
        for note in (33, 108):
            self.send(0x90, note, 127)
            self.assertTrue(self.command().gate)

    def test_velocity_and_cc7_match_documented_16_level_formula(self):
        for velocity in range(1, 128):
            for volume in range(128):
                level = ((velocity // 8 + 1) * (volume // 8 + 1)) // 16
                self.assertEqual(self.lib.famidi_volume(velocity, volume), max(0, level - 1))
        self.send(0x90, 69, 127)
        self.send(0xB0, 7, 64)
        self.assertEqual(self.command().volume, 8)
        self.assertFalse(self.command().retrigger)
        self.send(0xB0, 7, 0)
        self.assertEqual(self.command().volume, 0)
        self.assertTrue(self.command().gate)
        self.send(0xB0, 7, 127)
        self.assertEqual(self.command().volume, 15)

    def test_pitch_bend_14_bit_order_center_endpoints_and_low_range(self):
        self.send(0x90, 69, 127)
        timers = []
        for bend in (0, 8192, 16383):
            self.send(0xE0, bend & 127, bend >> 7)
            expected = round((21477272 / 12) / (16 * 440 * 2 ** (((bend - 8192) / 4096) / 12)) - 1)
            self.assertEqual(self.command().timer, expected)
            timers.append(expected)
        self.assertGreater(timers[0], timers[1])
        self.assertGreater(timers[1], timers[2])
        self.send(0x90, 33, 127)
        self.send(0xE0, 0, 0)
        self.assertFalse(self.command().gate)
        self.send(0xE0, 0, 64)
        self.assertTrue(self.command().gate)
        for note in range(33, 109):
            timer = self.lib.famidi_note_timer(note, 8192)
            self.assertTrue(8 <= timer <= 2047)
            expected = round((21477272 / 12) / (16 * 440 * 2 ** ((note - 69) / 12)) - 1)
            self.assertEqual(timer, expected)

    def test_backpressure_keeps_order_and_note_off_for_retry(self):
        for index in range(64):
            self.assertTrue(self.send(0x90, 69, index + 1))
        self.assertFalse(self.send(0x80, 69, 0))
        self.assertTrue(self.midi.voices[0].gate)
        self.assertEqual(self.midi.count, 64)
        self.poll(0xf0)
        self.assertEqual(self.midi.count, 63)
        self.assertTrue(self.send(0x80, 69, 0))
        self.assertEqual(self.midi.count, 64)
        self.assertFalse(self.command().gate)
        self.assertEqual(self.link.active.volume, 0)
        self.assertEqual(self.command(62).volume, 8)

    def test_pairs_and_phase_restart_only_when_needed(self):
        applied = Command(253, 15, True, False)
        for command, high_write in [(Command(253, 8, True, False), False),
                                    (Command(240, 15, True, False), False),
                                    (Command(300, 15, True, False), True),
                                    (Command(253, 15, True, True), True),
                                    (Command(253, 0, False, False), False)]:
            program = self.program(command, applied)
            self.assertEqual(3 in program[::2], high_write)
            self.assertEqual(len(program) % 2, 0)
            self.assertTrue(all(register <= 0x17 for register in program[::2]))
        self.assertEqual(self.program(Command(253, 15, True, True)), bytes([0, 0xbf, 2, 0xfd, 3, 8]))
        self.assertEqual(self.program(Command(253, 0, False, False)), bytes([0, 0xb0]))

    def test_publish_ack_and_return_guard_preserve_immutable_rom(self):
        self.send(0x90, 69, 127)
        self.send(0x80, 69, 0)
        before = bytes(self.rom)
        for pins in (0, 0x30, 0xf1, 0x100f0, 0x200f0, 0x300f0):
            self.poll(pins)
        self.assertEqual(bytes(self.rom), before)
        self.poll(0xf0)
        self.assertEqual((self.rom[0xf0], self.rom[0xf1]), (1, 0))
        published = bytes(self.rom)
        for pins in (0xf0, 0x80, 0xb0, 0x100f1, 0x200f1, 0x300f1):
            self.poll(pins)
        self.assertEqual(bytes(self.rom), published)
        self.poll(0xf1)
        self.assertEqual((self.rom[0xf0], self.rom[0xf1]), (0, 1))
        acknowledged = bytes(self.rom)
        for pins in (0xf1, 0x59, 0x5c, 0x30, 0x100f0):
            self.poll(pins)
        self.assertEqual(bytes(self.rom), acknowledged)
        self.assertEqual(self.midi.count, 1)
        self.poll(0xf0)
        self.assertEqual(self.midi.count, 0)
        self.assertEqual((self.rom[0xf0], self.rom[0xf1]), (1, 0))
        allowed = set(range(0x80, 0xb0)) | {0xb0, 0xf0, 0xf1}
        for address in set(range(256)) - allowed:
            self.assertEqual(self.rom[address], before[address])

    def test_disconnect_panic_replaces_backlog_after_active_batch(self):
        for _ in range(64):
            self.send(0x90, 69, 127)
        self.poll(0xf0)
        active = bytes(self.rom)
        self.lib.famidi_midi_panic(ct.byref(self.midi))
        self.assertEqual(self.midi.count, 4)
        self.assertFalse(self.command().gate)
        self.assertEqual(bytes(self.rom), active)
        self.poll(0xf1)
        self.poll(0xf0)
        self.assertFalse(self.link.active.gate)

    def boot_cpu(self, snoop=None):
        test = self

        class Memory:
            def __init__(self):
                self.ram = bytearray(0x8000)
                self.writes = []
                self.snoop = None

            def __getitem__(self, address):
                if address >= 0x8000:
                    value = test.rom[address & 255]
                    if self.snoop:
                        self.snoop(address & 255)
                    # Return the pre-publication value, forcing another poll
                    # when RP2350 changes READY/RELEASE during this read.
                    return value
                return self.ram[address]

            def __setitem__(self, address, value):
                if address >= 0x8000:
                    raise AssertionError("CPU must never write ROM")
                self.ram[address] = value
                if address >= 0x2000:
                    self.writes.append((address, value))

        memory = Memory()
        cpu = MPU(memory=memory, pc=None)
        for _ in range(100):
            cpu.step()
            if cpu.pc == self.labels["forever"]:
                break
        self.assertEqual(cpu.pc, self.labels["forever"])
        self.assertTrue(cpu.p & cpu.INTERRUPT)  # SEI stays set: no IRQ required
        self.assertEqual(memory.ram[0x4000], 0xb0)
        memory.writes.clear()
        memory.snoop = snoop
        return cpu, memory

    def drain(self, cpu, limit=20000):
        for _ in range(limit):
            cpu.step()
            if (not self.midi.count and self.link.state == 0 and
                    self.rom[0xf0] == 0 and cpu.pc == self.labels["forever"]):
                self.assertEqual(cpu.sp, 255)
                self.assertTrue(cpu.p & cpu.INTERRUPT)
                return
        self.fail("Mailbox transaction failed to finish")

    def test_full_midi_to_6502_apu_without_irq(self):
        reads = {0xf0: 0, 0xf1: 0}

        def snoop(address):
            if address in reads:
                reads[address] += 1
                # Miss several reads in both phases; each is repeated safely.
                if reads[address] % 5 == 0:
                    self.poll(address)

        cpu, memory = self.boot_cpu(snoop)
        self.send(0x90, 69, 127)
        self.drain(cpu)
        self.assertEqual(memory.writes, [(0x4000, 0xbf), (0x4002, 0xfd), (0x4003, 8)])
        memory.writes.clear()
        self.send(0xB0, 7, 64)
        self.send(0xE0, 127, 127)
        self.send(0x80, 69, 0)
        self.drain(cpu)
        self.assertEqual(memory.writes[0], (0x4000, 0xb8))
        self.assertEqual(memory.writes[-1], (0x4000, 0xb0))
        self.assertEqual(sum(address == 0x4003 for address, _ in memory.writes), 0)
        self.assertGreaterEqual(reads[0xf1], 20)
        for _ in range(200):
            cpu.step()
        self.assertEqual(memory.writes[-1], (0x4000, 0xb0))
        self.assertEqual(len(memory.writes), 5)  # no duplicate batches

    def test_partial_publication_and_delayed_ack_do_not_tear_or_repeat(self):
        cpu, memory = self.boot_cpu()
        payload = bytes([0, 0xbf, 2, 0xfd, 3, 8])
        for offset, byte in enumerate(payload):
            self.rom[0x80 + offset] = byte
            for _ in range(30):
                cpu.step()
            self.assertEqual(memory.writes, [])
        self.rom[0xb0] = len(payload)
        for _ in range(30):
            cpu.step()
        self.assertEqual(memory.writes, [])
        self.rom[0xf0] = 1  # publish only after every payload/count byte
        for _ in range(300):
            cpu.step()
        expected = [(0x4000, 0xbf), (0x4002, 0xfd), (0x4003, 8)]
        self.assertEqual(memory.writes, expected)
        self.rom[0xf0] = 0  # closing READY alone cannot release the ACK loop
        for _ in range(100):
            cpu.step()
        self.assertEqual(memory.writes, expected)
        self.assertIn(cpu.pc, (self.labels["complete"], self.labels["complete"] + 3))
        self.rom[0xf1] = 1
        for _ in range(300):
            cpu.step()
        self.assertEqual(memory.writes, expected)

    def test_generic_apu_range_and_invalid_batches(self):
        for payload, size, expected in [
            (bytes(sum(([reg, reg + 0x40] for reg in range(24)), [])), 48,
             [(0x4000 + reg, reg + 0x40) for reg in range(24)]),
            (bytes([0, 1]), 0, []), (bytes([0, 1]), 1, []),
            (bytes([0, 1]), 49, []), (bytes([0, 1]), 255, []),
            (bytes([0x18, 1]), 2, []), (bytes([0xff, 1]), 2, []),
        ]:
            with self.subTest(size=size, first=payload[0]):
                self.rom = (ct.c_uint8 * 256).from_buffer_copy(self.base_rom)
                cpu, memory = self.boot_cpu()
                for index, byte in enumerate(payload):
                    self.rom[0x80 + index] = byte
                self.rom[0xb0], self.rom[0xf0] = size, 1
                for _ in range(2000):
                    cpu.step()
                self.assertEqual(memory.writes, expected)

    def test_random_service_gaps_queue_wrap_and_exactly_once_delivery(self):
        rng = random.Random(20261017)

        def snoop(address):
            if rng.randrange(20) == 0:
                self.poll(address)

        cpu, memory = self.boot_cpu(snoop)
        expected = []
        for batch in range(5):
            for _ in range(20):
                velocity = rng.randint(1, 127)
                self.send(0x90, 69, velocity)
                level = self.lib.famidi_volume(velocity, 127)
                expected += [(0x4000, 0xb0 | level), (0x4002, 0xfd), (0x4003, 8)]
                self.send(0x80, 69, 0)
                expected += [(0x4000, 0xb0)]
            self.drain(cpu, limit=200000)
        self.assertEqual(memory.writes, expected)
        self.assertEqual(self.midi.head, 200 % 64)

    def test_four_channels_have_independent_note_and_controller_state(self):
        for ch, note in enumerate((60, 64, 21, 127)):
            self.send(0x90 | ch, note, 127)
            self.assertEqual(self.command().channel, ch)
            self.assertTrue(self.command().gate)
        self.send(0xb1, 7, 64)
        self.send(0xb1, 11, 64)
        self.assertEqual(self.command().volume, max(0, 16 * 9 * 9 // 256 - 1))
        self.assertEqual(self.midi.voices[0].volume, 127)
        self.send(0x81, 64, 0)
        self.assertFalse(self.command().gate)
        self.assertTrue(self.midi.voices[0].gate)
        self.assertTrue(self.midi.voices[2].gate)
        for cc in (120, 123):
            self.send(0xb2, cc, 0)
            self.assertFalse(self.command().gate)
        self.assertTrue(self.midi.voices[3].gate)

    def test_expression_formula_all_steps_and_triangle_binary_volume(self):
        for vel in range(0, 128, 8):
            for vol in range(0, 128, 8):
                for expr in range(0, 128, 8):
                    self.assertEqual(self.lib.famidi_level(vel, vol, expr),
                                     max(0, (vel // 8 + 1) * (vol // 8 + 1) * (expr // 8 + 1) // 256 - 1))
        self.send(0x92, 69, 1)
        self.assertTrue(self.command().gate)
        self.assertEqual(self.command().timer, 126)
        self.send(0xb2, 11, 0)
        self.assertFalse(self.command().gate)
        self.send(0xb2, 11, 1)
        self.assertTrue(self.command().gate)
        self.send(0xb2, 7, 0)
        self.assertFalse(self.command().gate)
        self.send(0xb2, 7, 1)
        self.assertTrue(self.command().gate)
        for note in (20, 97):
            self.send(0x92, note, 127)
            self.assertEqual(self.midi.voices[2].note, 69)
        self.send(0xe2, 0, 0)
        self.assertGreater(self.command().timer, 126)

    def test_duty_sweep_program_change_and_reset(self):
        self.send(0x91, 69, 127)
        for value in (0, 31, 32, 63, 64, 95, 96, 127):
            self.send(0xb1, 70, value)
            self.assertEqual(self.command().duty, value // 32)
            self.assertEqual(self.program(self.command())[1] >> 6, value // 32)
        self.send(0xc1, 5, 0)
        self.assertEqual(self.command().duty, 1)
        for cc, value in ((13, 127), (14, 0), (15, 127), (16, 32)):
            self.send(0xb1, cc, value)
        self.assertEqual(self.command().sweep, 0xf2)
        self.assertIn(bytes([5, 0xf2]), self.program(self.command()))
        self.send(0xb1, 121, 0)
        self.assertEqual((self.command().sweep, self.command().duty), (8, 2))
        self.assertTrue(self.command().gate)

    def test_noise_map_and_unsupported_bend(self):
        for note in range(128):
            # Drain queue manually; this test only inspects MIDI snapshots.
            self.midi.count = 0
            self.send(0x93, note, 127)
            self.assertEqual(self.command().noise, (note % 16) | (0x80 if note >= 64 else 0))
            self.assertEqual(self.program(self.command()), bytes([12, 0x3f, 14, self.command().noise, 15, 8]))
        before = self.midi.count
        self.send(0xe3, 0, 0)
        self.assertEqual(self.midi.count, before)

    def test_four_voices_through_real_6502_and_per_voice_applied_state(self):
        cpu, memory = self.boot_cpu(self.poll)
        expected = []
        applied = [Command() for _ in range(4)]
        for ch, note in enumerate((69, 72, 69, 68)):
            self.send(0x90 | ch, note, 127)
            command = self.command()
            payload = self.program(command, applied[ch])
            expected += list(zip([0x4000 + n for n in payload[::2]], payload[1::2]))
            applied[ch] = command
        self.drain(cpu)
        self.assertEqual(memory.writes, expected)
        self.assertEqual(memory.ram[0x4015], 15)
        self.assertEqual(memory.ram[0x4008], 255)
        memory.writes.clear()
        # Switching between channels must not reset either pulse's phase.
        self.send(0xb0, 11, 64)
        self.send(0xb1, 7, 64)
        self.drain(cpu)
        self.assertNotIn(0x4003, [r for r, _ in memory.writes])
        self.assertNotIn(0x4007, [r for r, _ in memory.writes])
        memory.writes.clear()
        self.lib.famidi_midi_panic(ct.byref(self.midi))
        self.drain(cpu)
        self.assertEqual(memory.writes, [(0x4000, 0xb0), (0x4004, 0xb0),
                                         (0x4008, 0x80), (0x4017, 0xc0), (0x400c, 0x30)])

    def test_sweep_changes_while_muted_are_applied_before_next_note(self):
        cpu, memory = self.boot_cpu(self.poll)
        self.send(0xb1, 13, 127)
        self.drain(cpu)
        self.assertEqual(memory.ram[0x4005], 0x9b)
        memory.writes.clear()
        self.send(0x91, 69, 127)
        self.drain(cpu)
        self.assertEqual(memory.ram[0x4005], 0x9b)
        self.assertEqual(memory.ram[0x4004], 0xbf)
        self.send(0x81, 69, 0)
        self.send(0xb1, 13, 0)
        self.drain(cpu)
        self.assertEqual(memory.ram[0x4005], 8)

    def test_triangle_immediate_linear_counter_mute_and_recovery(self):
        cpu, memory = self.boot_cpu(self.poll)
        for status, first, second, linear in [(0x92, 69, 1, 255),
                                             (0xb2, 11, 0, 128),
                                             (0xb2, 11, 1, 255),
                                             (0x82, 69, 0, 128)]:
            memory.writes.clear()
            self.send(status, first, second)
            self.drain(cpu)
            self.assertEqual(memory.writes[0], (0x4008, linear))
            self.assertEqual(memory.writes[-1], (0x4017, 0xc0))

    def test_rom_layout_vectors_and_branch_validation(self):
        self.assertEqual(len(self.base_rom), 256)
        for label, address in (("commands", 0x8080), ("values", 0x8081),
                               ("command_size", 0x80b0), ("ready", 0x80f0), ("release", 0x80f1)):
            self.assertEqual(self.labels[label], address)
        for vector, label in ((0xfa, "interrupt"), (0xfc, "reset"), (0xfe, "interrupt")):
            self.assertEqual(int.from_bytes(self.base_rom[vector:vector + 2], "little"), self.labels[label])
        with self.assertRaisesRegex(ValueError, "branch out of range"):
            assembler.assemble(".org $8000\nbeq distant\n.org $80f0\ndistant:\nrti")


if __name__ == "__main__":
    unittest.main()
