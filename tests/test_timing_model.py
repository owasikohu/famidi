"""Cross-check branch folding against measured examples in the RP2350 manual."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("analyze_timing", ROOT / "tools/analyze_timing.py")
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)


class TimingModelTest(unittest.TestCase):
    def delay_loop(self, start):
        # RP2350 datasheet release 8, 3.7.4.9.7, measured MOVS/SUBS/BNE loops.
        code = {
            start: {"address": start, "width": 2, "op": "movs", "arg": "r5, #100", "text": "movs r5, #100"},
            start + 2: {"address": start + 2, "width": 2, "op": "subs", "arg": "r5, r5, #1", "text": "subs r5, r5, #1"},
            start + 4: {"address": start + 4, "width": 2, "op": "bne", "arg": f"{start + 2:x}", "text": "bne loop"},
        }
        seq = [dict(code[start], branched_to=False)]
        for i in range(100):
            seq.append(dict(code[start + 2], branched_to=i != 0))
            seq.append(dict(code[start + 4], branched_to=False, taken=i != 99))
        return model.timing(seq, code)["cycles"]

    def test_official_word_aligned_target_example_299_cycles(self):
        self.assertEqual(self.delay_loop(0x10000002), 299)

    def test_official_halfword_aligned_target_example_300_cycles(self):
        self.assertEqual(self.delay_loop(0x10000000), 300)


if __name__ == "__main__":
    unittest.main()
