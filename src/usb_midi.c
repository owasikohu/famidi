#include "usb_midi.h"

#include "hardware/structs/sio.h"
#include "pico.h"
#include "tusb.h"
#include "midi_engine.h"

extern uint8_t rom256[256];
static famidi_midi midi;
static famidi_link link;

static void discard_usb_rx(void) {
    uint8_t packet[4];
    while (tud_midi_packet_read(packet)) {}
}

void tud_umount_cb(void) {
    famidi_midi_panic(&midi);
}

void tud_suspend_cb(bool remote_wakeup_en) {
    (void)remote_wakeup_en;
    discard_usb_rx();
    famidi_midi_panic(&midi);
}

void tud_resume_cb(void) {
    // Do not replay buffered pre-suspend notes after the panic has silenced them.
    discard_usb_rx();
}

void famidi_usb_main(void) {
    famidi_midi_init(&midi);
    famidi_link_init(&link);
    const tusb_rhport_init_t init = {.role = TUSB_ROLE_DEVICE, .speed = TUSB_SPEED_FULL};
    // Initialization and USB IRQ ownership both belong to core 0.
    __asm volatile("cpsie i" ::: "memory");
    if (!tusb_init(0, &init)) {
        while (true) tight_loop_contents();
    }
    bool was_usable = false;
    while (true) {
        // Nonblocking: tud_task()'s default timeout must not starve the handshake.
        tud_task_ext(0, false);
        const bool usable = tud_mounted() && !tud_suspended();
        // A USB bus reset does not necessarily invoke tud_umount_cb().
        if (was_usable && !usable) famidi_midi_panic(&midi);
        was_usable = usable;
        famidi_link_poll(&link, &midi, rom256, sio_hw->gpio_in);
        if (!usable) continue;
        for (unsigned budget = 0; budget < 8 && midi.count < FAMIDI_QUEUE_SIZE; ++budget) {
            uint8_t packet[4];
            if (!tud_midi_packet_read(packet)) break;
            // Capacity is checked before removing a USB event, so Note Off is
            // never dropped by our queue. USB OUT applies backpressure upstream.
            (void)famidi_midi_packet(&midi, packet);
            famidi_link_poll(&link, &midi, rom256, sio_hw->gpio_in);
        }
    }
}
