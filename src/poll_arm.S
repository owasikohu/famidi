.syntax unified
.cpu cortex-m33
.thumb

// r0 = the 256-byte ROM in SRAM. Leaf function; never returns.
// All code/literals in SRAM bank 8 (.scratch_x), initialized by SDK crt0.
.section .scratch_x.rom_poll_arm, "ax", %progbits
.balign 4
.global rom_poll_arm
.type rom_poll_arm, %function
.thumb_func
rom_poll_arm:
    ldr r1, =0xd0000000      // SIO_BASE, secure Cortex-M33
    mov.w r2, #0x30000      // /CE | /OE
    mov.w r3, #0xff00       // D0..7 output-enable mask
.balign 4
.Lsample:
    ldr r4, [r1, #4]        // GPIO_IN (including synchronizers)
    tst r4, r2
    bne .Lidle
    uxtb r4, r4             // A0..7 from the same snapshot
    ldrb r4, [r0, r4]       // SRAM ROM lookup
    lsls r4, r4, #8
    str r4, [r1, #0x10]     // GPIO_OUT: data before output enable
    str r3, [r1, #0x38]     // GPIO_OE_SET
    b .Lsample              // keep updating if address changes while selected
.balign 4                  // allow the idle STR + B to fold too
.Lidle:
    str r3, [r1, #0x40]     // GPIO_OE_CLR
    b .Lsample
.size rom_poll_arm, . - rom_poll_arm
.ltorg
