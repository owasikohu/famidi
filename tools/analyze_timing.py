#!/usr/bin/env python3
"""Audit the linked ARM binaries and apply RP2350 datasheet 3.7.4.9 timings.

This is a no-contention instruction model, NOT a physical-pad measurement or
certified WCET. Branch folding, modified-immediate flag penalties and load-use
stalls come from actual opcodes/addresses, rather than C source line counts.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile


def command(*args):
    return subprocess.check_output(args, text=True)


def instructions(disassembly):
    result = {}
    for line in disassembly.splitlines():
        match = re.match(r"\s*([0-9a-f]+):\s+((?:[0-9a-f]{4}\s+)+)\s*([a-z][a-z0-9.]*)\s*(.*)", line)
        if match:
            address, encoding, mnemonic, operand = match.groups()
            result[int(address, 16)] = {
                "address": int(address, 16), "width": len(encoding.split()) * 2,
                "op": mnemonic.split(".")[0], "arg": operand.split("@")[0].strip(),
                "text": line.strip(),
            }
    if not result:
        raise ValueError("No instructions found")
    return result


def path(code, start, selected, endpoint):
    """Walk linked control flow to an OE write or the next GPIO_IN read."""
    pc, result, branched_to = start, [], False
    for _ in range(64):
        inst = dict(code[pc], branched_to=branched_to)
        if result and endpoint == "sample" and is_sample(inst):
            return result
        result.append(inst)
        if inst["op"] == "str" and endpoint == "oe" and (
                (selected and "#56]" in inst["arg"]) or
                (not selected and "#64]" in inst["arg"])):
            return result
        branch = inst["op"]
        taken = branch == "b" or (branch == "beq" and selected) or (branch == "bne" and not selected)
        if branch in ("b", "beq", "bne"):
            inst["taken"] = taken
        pc = int(inst["arg"].split()[0], 16) if taken else pc + inst["width"]
        branched_to = taken
    raise ValueError("No endpoint reached")


def is_sample(inst):
    return inst["op"] == "ldr" and re.search(r"\[r\d+, #4\]", inst["arg"])


def complex_immediate(value):
    # RP2350 3.7.4.9.2: the four simple modified-immediate forms.
    return not any(value in (xy, xy * 0x01010101, xy * 0x00010001, xy * 0x01000100) for xy in range(256))


def timing(sequence, code):
    now, ready, previous, previous_folded, details = 0, {}, None, False, []
    for inst in sequence:
        op, arg = inst["op"], inst["arg"]
        regs = re.findall(r"\br\d+\b", arg)
        if op in ("ldr", "ldrb", "str"):
            # Store-data registers do NOT incur the load result-use penalty.
            sources = re.findall(r"\br\d+\b", arg.split("[", 1)[1])
        elif op == "tst":
            sources = regs
        elif op in ("uxtb", "lsls", "mov", "movs", "subs"):
            sources = regs[1:]
        elif op in ("b", "beq", "bne", "nop"):
            sources = []
        else:
            raise ValueError(f"Unsupported timing opcode: {inst['text']}")
        stall = max([0] + [ready.get(reg, 0) - now for reg in sources])
        now += stall
        start, duration, folded, fk = now, 1, False, None
        if op in ("b", "beq", "bne"):
            f = int(previous is not None and previous["width"] == 2
                    and (not previous["branched_to"] or previous["address"] % 4 == 0)
                    and not previous_folded)
            k = int(op == "b" or previous["op"] not in ("tst", "lsls", "movs", "subs"))
            if inst["taken"]:
                target = int(arg.split()[0], 16)
                u = int(target % 4 != 0 and code[target]["width"] == 4)
                duration = 2 + u - (k & f)
            else:
                duration = 1 - f
            folded, fk = bool(f), {"F": f, "K": k}
        elif op == "tst" and "#" in arg and complex_immediate(int(arg.split("#")[1])):
            duration += 1  # compulsory flag-setting complex-immediate penalty
        if op in ("ldr", "ldrb"):
            ready[regs[0]] = start + 2
        elif op in ("uxtb", "lsls", "mov", "movs", "subs"):
            ready[regs[0]] = start + 1
        now += duration
        details.append({"instruction": inst["text"], "load_use_stall": stall,
                        "cycles": duration, "branch": fk})
        previous, previous_folded = inst, folded
    return {"instructions": len(sequence), "cycles": now, "detail": details}


def audit(elf, symbol, args, midi=False):
    dis = command(args.objdump, "-d", f"--disassemble={symbol}", str(elf))
    code = instructions(dis)
    samples = [pc for pc, inst in code.items() if is_sample(inst)]
    active_start, idle_start = samples[0], samples[-1]
    result = {}
    for name, start, selected, endpoint in (
            ("read_from_active", active_start, True, "oe"),
            ("read_from_idle", idle_start, True, "oe"),
            ("active_poll_period", active_start, True, "sample"),
            ("idle_poll_period", idle_start, False, "sample"),
            ("release_from_active", active_start, False, "oe")):
        result[name] = timing(path(code, start, selected, endpoint), code)
    nm = command(args.nm, "-S", str(elf))
    for name, expected_size, lower, upper in ((symbol, None, 0x20080000, 0x20081000),
                                             ("rom256", 256, 0x20081000, 0x20082000)):
        match = re.search(rf"^([0-9a-f]+) ([0-9a-f]+) \w {name}$", nm, re.M)
        if not match:
            raise ValueError(f"Missing {name} symbol")
        address, size = (int(group, 16) for group in match.groups())
        if not lower <= address < address + size <= upper or (expected_size and size != expected_size):
            raise ValueError(f"Unexpected placement/size of {name}")
        result[name] = {"address": hex(address), "bytes": size}
    for forbidden in ("gpio_init", "gpio_get", "gpio_put", "gpio_set_dir", "stdio_usb_init",
                      "multicore_launch_core1", "alarm_pool_irq_handler", "runtime_init_default_alarm_pool"):
        if midi and forbidden == "multicore_launch_core1":
            continue
        if re.search(rf"\b{forbidden}$", nm, re.M):
            raise ValueError(f"Unexpected linked functionality: {forbidden}")
    with tempfile.TemporaryDirectory() as tmp:
        extracted = Path(tmp) / "rom.bin"
        subprocess.run([args.objcopy, "-O", "binary", "--only-section=.scratch_y", str(elf), str(extracted)], check=True)
        if extracted.read_bytes() != (elf.parent / "generated/rom256.bin").read_bytes():
            raise ValueError("Linked SRAM ROM differs from generated ROM")
    best_cpu = min(result[key]["cycles"] for key in ("read_from_active", "read_from_idle"))
    # Miss an input sample just as the previous ACTIVE iteration begins. Include
    # that iteration in flight, then the next complete response. Idle periods are
    # checked too; this deliberately conservative bound includes the first LDR.
    worst_cpu = max(result["active_poll_period"]["cycles"] + result["read_from_active"]["cycles"],
                    result["idle_poll_period"]["cycles"] + result["read_from_idle"]["cycles"])
    result["theoretical_gpio_to_sio_oe"] = {
        "best_cycles": 2 + best_cpu, "worst_cycles": 3 + worst_cpu,
        "best_ns_at_150MHz": (2 + best_cpu) * 1000 / 150,
        "worst_ns_at_150MHz": (3 + worst_cpu) * 1000 / 150,
        "note": "Includes 2..3 input-sync/phase cycles; excludes pad, translators, board and CPU setup time. No metastability extension or bus contention.",
    }
    result["theoretical_release_worst_cycles"] = 3 + result["active_poll_period"]["cycles"] + result["release_from_active"]["cycles"]
    result["sha256_elf"] = hashlib.sha256(elf.read_bytes()).hexdigest()
    result["sha256_uf2"] = hashlib.sha256(elf.with_suffix(".uf2").read_bytes()).hexdigest()
    # Avoid recording cloud-machine absolute paths in committed evidence.
    dis = dis.replace(str(elf), elf.name)
    return result, dis


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--c", type=Path, required=True)
    parser.add_argument("--asm", type=Path, required=True)
    parser.add_argument("--midi", type=Path, help="Also audit the dual-core USB MIDI build")
    parser.add_argument("--out", type=Path, required=True)
    for tool in ("objdump", "nm", "objcopy", "gcc"):
        parser.add_argument(f"--{tool}", default=f"arm-none-eabi-{tool}")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    report = {"model": "RP2350 datasheet release 8, 3.7.4.9; one core, no DMA/IRQs/contention, split SRAM banks, 150MHz", "compiler": command(args.gcc, "--version").splitlines()[0]}
    targets = [("c", args.c, "rom_poll_c"), ("asm", args.asm, "rom_poll_arm")]
    if args.midi:
        targets.append(("midi", args.midi, "rom_poll_arm"))
    for name, elf, symbol in targets:
        report[name], dis = audit(elf, symbol, args, midi=name == "midi")
        if name == "midi":
            report[name]["concurrency_note"] = (
                "Unchanged polling instruction model only. Core 1 serves ROM; core 0 runs USB "
                "and publishes a mailbox in bank 9 while NES waits. Multicore/SIO contention is not modeled; "
                "the original one-core timing bounds are not a hardware guarantee for USB MIDI.")
        (args.out / f"{name}-loop.dis").write_text(dis)
    (args.out / "timing.json").write_text(json.dumps(report, indent=2) + "\n")
    for name, _, _ in targets:
        print(name, report[name]["theoretical_gpio_to_sio_oe"])


if __name__ == "__main__":
    main()
