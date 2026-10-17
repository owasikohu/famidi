#include <string.h>

#include "pico/unique_id.h"
#include "tusb.h"

// TinyUSB's example VID/PID, for this development PoC only.
static const tusb_desc_device_t device = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = 0xcafe,
    .idProduct = 0x4008,
    .bcdDevice = 0x0100,
    .iManufacturer = 1,
    .iProduct = 2,
    .iSerialNumber = 3,
    .bNumConfigurations = 1,
};

static const uint8_t configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, 2, 0, TUD_CONFIG_DESC_LEN + TUD_MIDI_DESC_LEN, 0, 100),
    TUD_MIDI_DESCRIPTOR(0, 0, 0x01, 0x81, 64),
};

uint8_t const *tud_descriptor_device_cb(void) {
    return (const uint8_t *)&device;
}

uint8_t const *tud_descriptor_configuration_cb(uint8_t index) {
    return index == 0 ? configuration : NULL;
}

uint16_t const *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void)langid;
    static uint16_t descriptor[32];
    if (index == 0) {
        descriptor[0] = (TUSB_DESC_STRING << 8) | 4;
        descriptor[1] = 0x0409;
        return descriptor;
    }
    char serial[PICO_UNIQUE_BOARD_ID_SIZE_BYTES * 2 + 1];
    const char *value;
    if (index == 1) value = "famidi";
    else if (index == 2) value = "famidi Pulse 1";
    else if (index == 3) {
        pico_get_unique_board_id_string(serial, sizeof serial);
        value = serial;
    } else return NULL;
    size_t length = strlen(value);
    if (length > 31) length = 31;
    for (size_t i = 0; i < length; ++i) descriptor[i + 1] = (uint8_t)value[i];
    descriptor[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * length + 2));
    return descriptor;
}
