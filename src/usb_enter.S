.syntax unified
.cpu cortex-m33
.thumb
.section .text.famidi_usb_enter, "ax", %progbits
.global famidi_usb_enter
.type famidi_usb_enter, %function
.thumb_func
famidi_usb_enter:
    msr msp, r0              // aligned normal-SRAM USB stack, never bank 9
    b famidi_usb_main        // noreturn: do not retain an old-stack return frame
.size famidi_usb_enter, . - famidi_usb_enter
