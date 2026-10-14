; 256-byte ROM mirrored throughout $8000-$FFFF. No assembler dependency:
; tools/gen_rom.py implements just the documented instructions below.
.org $8000
reset:
    sei
    cld
    ldx #$ff
    txs
    lda #$00
    sta $2000       ; PPU NMI off
    sta $2001       ; rendering off (existing CHR/PPU circuitry is left in place)
    sta $4010       ; DMC IRQ off
    sta $4015       ; all channels/DMC off
    lda #$40
    sta $4017       ; frame IRQ inhibited
    lda #$01
    sta $4015       ; enable Pulse 1 only
    lda #$bf
    sta $4000       ; 50% duty, length halt, constant volume=15
    lda #$08
    sta $4001       ; sweep disabled, negate set
    lda #$fd
    sta $4002       ; timer=253 -> ~440.4 Hz on NTSC, ~409.1 Hz PAL
    lda #$08
    sta $4003       ; length load, timer high bits=0; sequencer restart
forever:
    jmp forever
interrupt:
    rti
.org $80fa
    .word interrupt ; NMI vector, also visible at $FFFA
    .word reset     ; RESET vector, also visible at $FFFC
    .word interrupt ; IRQ/BRK vector, also visible at $FFFE
