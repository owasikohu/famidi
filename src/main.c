#include <stdint.h>
#include "pico.h"
#include "hardware/clocks.h"
#include "hardware/structs/io_bank0.h"
#include "hardware/structs/pads_bank0.h"
#include "hardware/structs/sio.h"
#include "hardware/structs/syscfg.h"
#include "rom256.h"

enum {
    ADDRESS_MASK = 0xffu,       // GP0..7
    DATA_MASK = 0xff00u,        // GP8..15
    CONTROL_MASK = 3u << 16,    // GP16=/CE, GP17=/OE (both active low)
    INHIBIT_MASK = 1u << 18,    // GP18: low when initialized; external pull-up
};

// Dedicated SRAM bank 9; copied from the flash load image by pico-sdk crt0.
// Mutable storage prevents the compiler from turning it into flash constants.
uint8_t __scratch_y("rom256") __attribute__((aligned(256))) rom256[256] = ROM256_BYTES;
_Static_assert(sizeof rom256 == 256, "The mirrored ROM must be exactly 256 bytes");

#if defined(FAMIDI_ASM)
extern void __attribute__((noreturn)) rom_poll_arm(const uint8_t *rom);
#else
// Dedicated SRAM bank 8, separate from the ROM and ordinary stack/data SRAM.
void __scratch_x("rom_poll_c") __attribute__((noreturn, noinline, aligned(4)))
rom_poll_c(const uint8_t *rom) {
    for (;;) {
        const uint32_t pins = sio_hw->gpio_in;
        if (pins & CONTROL_MASK) {
            sio_hw->gpio_oe_clr = DATA_MASK;
        } else {
            // The same sample supplies both address and selection state.
            // No other SIO outputs are owned by this firmware; GP18 stays low.
            sio_hw->gpio_out = (uint32_t)rom[pins & ADDRESS_MASK] << 8;
            sio_hw->gpio_oe_set = DATA_MASK;
        }
    }
}
#endif

int main(void) {
    // No stdio, USB initialization, IRQ handler, PIO or core-1 launch.
    // The USB connector supplies power only after booting from flash.
    set_sys_clock_khz(150000, true);
    __asm volatile("cpsid i" ::: "memory");
    // Disable SysTick as well; boot normally leaves it stopped.
    *(volatile uint32_t *)0xe000e010u = 0;

    sio_hw->gpio_oe_clr = ADDRESS_MASK | DATA_MASK | CONTROL_MASK | INHIBIT_MASK;
    sio_hw->gpio_out = 0;
    // Keep the normal two-flop input synchronizers enabled. Bypassing them on
    // an asynchronous CPU bus would remove latency but introduce metastability.
    syscfg_hw->proc_in_sync_bypass &= ~(ADDRESS_MASK | CONTROL_MASK);
    for (unsigned gpio = 0; gpio <= 18; ++gpio) {
        // Direct IO_BANK0/PADS_BANK0 accesses, not gpio_init/set_dir/put/get.
        io_bank0_hw->io[gpio].ctrl = IO_BANK0_GPIO0_CTRL_FUNCSEL_VALUE_SIOB_PROC_0;
        // Writing the whole pad register clears ISO, OD, pulls and Schmitt.
        // Inputs: IE only; outputs: fast slew, 4 mA, no input buffer or pulls.
        pads_bank0_hw->io[gpio] = ((gpio >= 8 && gpio <= 15) || gpio == 18)
            ? PADS_BANK0_GPIO0_SLEWFAST_BITS |
              (1u << PADS_BANK0_GPIO0_DRIVE_LSB)
            : PADS_BANK0_GPIO0_IE_BITS;
    }
    // Enable this only after all initialization. The external OR gate prevents
    // the NES data buffers from driving before readiness or outside ROM reads.
    sio_hw->gpio_oe_set = INHIBIT_MASK;
#if defined(FAMIDI_ASM)
    rom_poll_arm(rom256);
#else
    rom_poll_c(rom256);
#endif
}
