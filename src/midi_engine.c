#include "midi_engine.h"

#include <math.h>
#include <stdatomic.h>
#include <string.h>

static void bus_barrier(void) {
#if defined(__arm__)
    // Publish payload bytes before READY and close READY before RELEASE.
    // USB core 0 can afford this; the core-1 polling loop remains untouched.
    __asm volatile("dsb sy" ::: "memory");
#else
    atomic_thread_fence(memory_order_seq_cst);
#endif
}

uint16_t famidi_note_timer(uint8_t note, uint16_t bend) {
    // NTSC 2A03. Center=8192, fixed +/-2 semitones (positive end < +2).
    const double semitones = (double)note - 69.0 + ((int)bend - 8192) / 4096.0;
    const double frequency = 440.0 * exp2(semitones / 12.0);
    const double timer = (21477272.0 / 12.0) / (16.0 * frequency) - 1.0;
    // Out-of-range notes are muted, never wrapped into another octave.
    if (timer < 7.5 || timer >= 2047.5) return 0;
    return (uint16_t)(timer + 0.5);
}

uint8_t famidi_level(uint8_t velocity, uint8_t volume, uint8_t expression) {
    // Famimimidi v0.7a: quantize each operand before multiplication.
    unsigned level = ((velocity >> 3) + 1u) * ((volume >> 3) + 1u) *
                     ((expression >> 3) + 1u) / 256u;
    return level ? (uint8_t)(level - 1u) : 0;
}

uint8_t famidi_volume(uint8_t velocity, uint8_t volume) {
    return famidi_level(velocity, volume, 127);
}

static void reset_controls(famidi_voice *voice) {
    voice->volume = voice->expression = 127;
    voice->duty = 2;
    voice->bend = 8192;
    voice->sweep_on = 0;
    voice->sweep_up = 1;
    voice->sweep_time = 1;
    voice->sweep_shift = 3;
}

void famidi_midi_init(famidi_midi *midi) {
    memset(midi, 0, sizeof *midi);
    for (unsigned ch = 0; ch < FAMIDI_VOICES; ++ch) {
        reset_controls(&midi->voices[ch]);
        midi->voices[ch].note = 69;
    }
}

static void enqueue(famidi_midi *midi, unsigned channel, bool retrigger) {
    const famidi_voice *voice = &midi->voices[channel];
    famidi_command *command = &midi->queue[(midi->head + midi->count) % FAMIDI_QUEUE_SIZE];
    memset(command, 0, sizeof *command);
    command->channel = (uint8_t)channel;
    // Triangle divides CPU by 32 instead of 16; the octave offset is exact.
    command->timer = channel == 3 ? 0 : famidi_note_timer(
        (uint8_t)(voice->note + (channel == 2 ? 12 : 0)), voice->bend);
    command->gate = voice->gate && (channel == 3 || command->timer != 0);
    if (channel == 2) command->gate = command->gate && voice->volume && voice->expression;
    command->volume = command->gate ? famidi_level(voice->velocity, voice->volume, voice->expression) : 0;
    command->duty = voice->duty;
    // Negate=1 raises pitch. Disabled sweep uses negate with shift=0 to avoid
    // the APU's target-overflow mute, which still applies with enable=0.
    command->sweep = voice->sweep_on ? (uint8_t)(0x80 | (voice->sweep_time << 4) |
                           (voice->sweep_up << 3) | voice->sweep_shift) : 0x08;
    // v0.7a Noise map: 0..63 long, 64..127 short; period repeats every 16.
    command->noise = (uint8_t)((voice->note & 15u) | (voice->note >= 64 ? 0x80 : 0));
    command->retrigger = retrigger;
    ++midi->count;
}

bool famidi_midi_packet(famidi_midi *midi, const uint8_t packet[4]) {
    const unsigned cin = packet[0] & 15u;
    const unsigned status = packet[1] >> 4;
    const unsigned channel = packet[1] & 15u;
    if ((packet[0] >> 4) != 0 || channel >= FAMIDI_VOICES || cin != status ||
        packet[2] > 127 || (status != 12 && packet[3] > 127)) return true;
    if (status != 8 && status != 9 && status != 11 && status != 12 && status != 14) return true;
    const unsigned cc = packet[2];
    if (status == 12 && channel > 1) return true;
    if (status == 14 && channel == 3) return true; // Noise has no bend in v0.7a.
    if (status == 11 && cc != 7 && cc != 11 && cc != 120 && cc != 121 && cc != 123 &&
        !(channel < 2 && (cc == 70 || (cc >= 13 && cc <= 16)))) return true;
    famidi_voice *voice = &midi->voices[channel];
    if (status == 8 || (status == 9 && packet[3] == 0)) {
        if (!voice->gate || packet[2] != voice->note) return true;
    } else if (status == 9) {
        unsigned low = channel == 2 ? 21 : 33;
        unsigned high = channel == 2 ? 96 : 108;
        if (channel != 3 && (packet[2] < low || packet[2] > high)) return true;
    }
    if (midi->count == FAMIDI_QUEUE_SIZE) return false;
    bool retrigger = false;
    if (status == 8 || (status == 9 && packet[3] == 0)) voice->gate = false;
    else if (status == 9) {
        voice->note = packet[2];
        voice->velocity = packet[3];
        voice->gate = true;
        retrigger = true;
    } else if (status == 12) voice->duty = packet[2] & 3u;
    else if (status == 11) {
        switch (cc) {
        case 7: voice->volume = packet[3]; break;
        case 11: voice->expression = packet[3]; break;
        case 70: voice->duty = packet[3] >> 5; break;
        case 13: voice->sweep_on = packet[3] >= 64; break;
        case 14: voice->sweep_up = packet[3] >= 64; break;
        case 15: voice->sweep_time = packet[3] >> 4; break;
        case 16: voice->sweep_shift = packet[3] >> 4; break;
        case 121: reset_controls(voice); break;
        default: voice->gate = false; break; // CC120 / CC123, channel-local.
        }
    } else voice->bend = (uint16_t)(packet[2] | ((uint16_t)packet[3] << 7));
    enqueue(midi, channel, retrigger);
    return true;
}

void famidi_midi_panic(famidi_midi *midi) {
    midi->head = midi->count = 0;
    for (unsigned ch = 0; ch < FAMIDI_VOICES; ++ch) {
        midi->voices[ch].gate = false;
        enqueue(midi, ch, false);
    }
}

static void store(uint8_t **out, uint8_t reg, uint8_t value) {
    *(*out)++ = reg;
    *(*out)++ = value;
}

size_t famidi_build_writes(uint8_t out[FAMIDI_COMMAND_CAPACITY],
                           const famidi_command *command,
                           const famidi_command *applied) {
    uint8_t *cursor = out;
    const unsigned ch = command->channel;
    if (ch >= FAMIDI_VOICES) return 0;
    const bool high_write = command->retrigger || !applied->gate ||
                           (command->timer >> 8) != (applied->timer >> 8);
    if (ch < 2) {
        const uint8_t base = (uint8_t)(ch * 4);
        store(&cursor, base, (uint8_t)((command->duty << 6) | 0x30 |
                                      (command->gate ? command->volume : 0)));
        if (command->sweep != applied->sweep)
            store(&cursor, base + 1, command->sweep);
        if (command->gate) {
            store(&cursor, base + 2, (uint8_t)command->timer);
            if (high_write) store(&cursor, base + 3, (uint8_t)(0x08 | (command->timer >> 8)));
        }
    } else if (ch == 2) {
        store(&cursor, 0x08, command->gate ? 0xff : 0x80);
        if (command->gate) {
            store(&cursor, 0x0a, (uint8_t)command->timer);
            if (high_write) store(&cursor, 0x0b, (uint8_t)(0x08 | (command->timer >> 8)));
        }
        // Clock the linear counter immediately for both note-on and mute.
        // 5-step mode, frame IRQ inhibited; no NES IRQ is ever enabled.
        store(&cursor, 0x17, 0xc0);
    } else {
        store(&cursor, 0x0c, (uint8_t)(0x30 | (command->gate ? command->volume : 0)));
        if (command->gate) {
            store(&cursor, 0x0e, command->noise);
            if (command->retrigger || !applied->gate) store(&cursor, 0x0f, 0x08);
        }
    }
    return (size_t)(cursor - out);
}

void famidi_link_init(famidi_link *link) {
    memset(link, 0, sizeof *link);
    for (unsigned ch = 0; ch < 2; ++ch) link->applied[ch].sweep = 0x08;
}

void famidi_link_poll(famidi_link *link, famidi_midi *midi,
                      volatile uint8_t rom[256], uint32_t pins) {
    if (pins & (3u << 16)) return;
    const unsigned address = pins & 255u;
    if (link->state == FAMIDI_WAIT_ACK) {
        if (address != FAMIDI_RELEASE_ADDRESS) return;
        // CPU is held at RELEASE after consuming the immutable payload.
        // Close READY before letting it return, preventing duplicate execution.
        rom[FAMIDI_READY_ADDRESS] = 0;
        bus_barrier();
        rom[FAMIDI_RELEASE_ADDRESS] = 1;
        link->applied[link->active.channel] = link->active;
        link->state = FAMIDI_WAIT_READY;
        return;
    }
    // A READY read proves the CPU has LEFT the preceding RELEASE loop.
    // Only now may we close RELEASE and replace the payload.
    if (address != FAMIDI_READY_ADDRESS) return;
    if (!midi->count) return;
    link->active = midi->queue[midi->head];
    midi->head = (midi->head + 1u) % FAMIDI_QUEUE_SIZE;
    --midi->count;
    uint8_t payload[FAMIDI_COMMAND_CAPACITY];
    const size_t size = famidi_build_writes(payload, &link->active, &link->applied[link->active.channel]);
    rom[FAMIDI_RELEASE_ADDRESS] = 0;
    for (size_t i = 0; i < size; ++i) {
        rom[FAMIDI_COMMAND_START + i] = payload[i];
    }
    rom[FAMIDI_COMMAND_SIZE_ADDRESS] = (uint8_t)size;
    bus_barrier();
    rom[FAMIDI_READY_ADDRESS] = 1;
    link->state = FAMIDI_WAIT_ACK;
}
