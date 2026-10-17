; IRQ-free MIDI mailbox. Same 256B mirror and unmodified ARM responder.
; CPU reads only: RP2350 observes the repeated READY / RELEASE reads.
.org $8000
reset:
    sei
    cld
    ldx #$ff
    txs
    lda #$00
    sta $2000
    sta $2001
    sta $4010
    sta $4015
    lda #$40
    sta $4017
    lda #$0f
    sta $4015
    lda #$b0
    sta $4000
    sta $4004
    lda #$08
    sta $4001
    sta $4005
    lda #$30
    sta $400c
    lda #$80
    sta $4008
    jmp forever
.org $8040
forever:
    lda ready
    beq forever
    lda command_size
    beq complete
    cmp #$31         ; at most 24 register/value pairs (48 bytes)
    bcs complete
    and #$01
    bne complete     ; refuse odd lengths
    ldx #$00
write_next:
    lda commands,x
    cmp #$18         ; never write outside $4000-$4017
    bcs complete
    tay
    lda values,x
    sta $4000,y
    inx
    inx
    cpx command_size
    bne write_next
complete:
    lda release
    beq complete     ; all APU stores finished; hold until RP2350 acknowledges
    jmp forever
.org $807f
interrupt:
    rti
.org $8080
commands:
.org $8081
values:
.org $80b0
command_size:
    .word $0000
.org $80f0
ready:
    .word $0000      ; READY=$F0, RELEASE=$F1 (both initially zero)
.org $80f1
release:
.org $80fa
    .word interrupt
    .word reset
    .word interrupt
