#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
    FAMIDI_VOICES = 4,
    FAMIDI_QUEUE_SIZE = 64,
    FAMIDI_COMMAND_START = 0x80,
    FAMIDI_COMMAND_CAPACITY = 48,
    FAMIDI_COMMAND_SIZE_ADDRESS = 0xb0,
    FAMIDI_READY_ADDRESS = 0xf0,
    FAMIDI_RELEASE_ADDRESS = 0xf1,
};

typedef struct {
    uint16_t timer;
    uint8_t volume;
    bool gate;
    bool retrigger;
    uint8_t channel, duty, sweep, noise;
} famidi_command;

typedef struct {
    uint8_t note, velocity, volume, expression, duty;
    uint8_t sweep_on, sweep_up, sweep_time, sweep_shift;
    uint16_t bend;
    bool gate;
} famidi_voice;

typedef struct {
    famidi_voice voices[FAMIDI_VOICES];
    famidi_command queue[FAMIDI_QUEUE_SIZE];
    unsigned head, count;
} famidi_midi;

void famidi_midi_init(famidi_midi *midi);
// False means backpressure: caller must retain the packet and retry.
bool famidi_midi_packet(famidi_midi *midi, const uint8_t packet[4]);
void famidi_midi_panic(famidi_midi *midi);
uint16_t famidi_note_timer(uint8_t note, uint16_t bend);
uint8_t famidi_volume(uint8_t velocity, uint8_t volume);
uint8_t famidi_level(uint8_t velocity, uint8_t volume, uint8_t expression);
// Returns byte count of (APU register offset, value) pairs, never 6502 opcodes.
size_t famidi_build_writes(uint8_t out[FAMIDI_COMMAND_CAPACITY],
                           const famidi_command *command,
                           const famidi_command *applied);

typedef enum {
    FAMIDI_WAIT_READY, FAMIDI_WAIT_ACK,
} famidi_link_state;

typedef struct {
    famidi_link_state state;
    famidi_command active, applied[FAMIDI_VOICES];
} famidi_link;

void famidi_link_init(famidi_link *link);
// Called on core 0 only. Core 1 continues its unmodified polling loop.
void famidi_link_poll(famidi_link *link, famidi_midi *midi,
                      volatile uint8_t rom[256], uint32_t pins);
