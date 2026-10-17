# USB MIDI → ROM mailbox → 4音源（IRQなし）

## 使える音源とメッセージ

Pico 2は通常のUSB MIDI 1.0 deviceとして動作し、DAW等から直接演奏できる。
Webアプリは任意のMIDIルーターで、ファームの動作には不要。
USB名は既存の接続設定を維持するため **`famidi Pulse 1` のまま**。4音源を同じポートで受ける。
USB hostは実装しないので、USB鍵盤はPCに接続し、DAWまたは [Web Console](../web-midi/README.md) で転送する。

| MIDI ch | 音源 | Note範囲 | Velocity / CC7 / CC11 | Pitch Bend |
|---|---|---|---|---|
| 1 | Pulse 1 | 33–108 | 16段階の積 | 14bit、固定±2半音 |
| 2 | Pulse 2 | 33–108 | 16段階の積 | 14bit、固定±2半音 |
| 3 | Triangle | 21–96 | 0でOFF、1以上は同じ音量 | 14bit、固定±2半音 |
| 4 | Noise | 0–127 | 16段階の積 | 無視（互換表に定義なし） |

全音源でNote On/Off、Note On Velocity 0、CC7、CC11、CC120 All Sound Off、
CC121 Reset All Controllers、CC123 All Notes Offに対応する。各音源は独立したモノ音源で最後のNote Onを優先。
古い異なるNoteのOffは無視し、ファーム単体では前の保持音へ復帰しない。
範囲外Note Onは現在音を奪わない。cable 0以外、ch5–16、未対応CC、SysEx、リアルタイムは無視。

Pulse共通の追加対応：

| メッセージ | 意味 | 初期値 |
|---|---|---|
| CC70 | Duty：0–31=12.5%、32–63=25%、64–95=50%、96–127=75% | 64（50%） |
| Program Change | 下位2bitでDuty、CC70と後着優先 | 2 |
| CC13 | Sweep：0–63 OFF / 64–127 ON | 0 |
| CC14 | Sweep方向：0–63 音程下降 / 64–127 音程上昇 | 127 |
| CC15 | Sweep時間：値//16、0–7 | 16（1） |
| CC16 | Sweep変化量：値//16、0–7 | 48（3） |

SweepはAPUのハードウェアSweepを使う。音域・設定次第でAPUのoverflow muteが起こる。
無効時は `$4001/$4005=$08` として、enable=0でも有効なtarget-overflow muteを避ける。
CC121はVolume/Expression=127、Bend中央、Duty50%、Sweep OFFと上表の初期値へ戻し、保持Noteは維持する。
CC120/123は指定チャンネルだけ即時消音し、他チャンネルのFIFO順序は維持する。

Noiseは公開表どおり **0–63=Long、64–127=Short、period=Note%16**。
`$400E = (Note>=64 ? $80 : 0) | (Note&15)` へ変換する。
Pulseはconstant volume/length halt、Noiseもconstant volume/length haltを使う。
Triangleは `$4008=$FF` で発音、`$80` で停止し、`$4017=$C0` でlinear counterを直ちにclockする。
TriangleのNote On/復帰時は必要なら `$400B` も書く。フレームIRQは禁止したまま。
PulseのCC/Bendではtimer上位が変わる場合以外 `$4003/$4007` を書かず、位相リセットを抑える。
適用済み状態を4音源別に持つので、音源を交互に操作しても他音源のtimerやphase判定を流用しない。

## 部分互換の範囲

[ふぁみみみっでぃ v0.7a 公開インプリメンテーション・チャート](https://hongera.sakura.ne.jp/Famimimidi_implement_chart_v07a_0816.pdf)
のch割当、音域、初期値、Duty/SweepのCC番号、Noiseノート表、音量式を採用する。
Pulse/Noise音量は整数演算で
`q=((Volume//8+1)×(Expression//8+1)×(Velocity//8+1))//256`、`level=max(0,q−1)`。
TriangleではVelocity 0をNote Offとし、CC7/11は0のときだけmuteする。

NTSC基準 `f=440×2^((note−69+bendSemitones)/12)`、
Pulse `timer=round((21477272/12)/(16×f)−1)`、Triangleは分母32。
timerが実装の範囲8–2047を外れるBendはmuteし、範囲内で復帰する。PAL補正は未対応。

今回の段階は4音源と上記コントロールの部分互換。
DPCM、ADSR/リリース、サステインCC64、モジュレーションCC1、RPN/NRPN、
可変Bend幅CC82、CC20入替、SysEx直接APU操作は未実装。
WebのOriginal互換はチャンネル配置と単音優先を維持するモードで、製品全機能の互換ではない。
次段階は実機4音源確認後、CC64→ADSR→Bend幅/RPN→モジュレーションの順に追加できる。
今回も既存256Bミラー・配線・ASM polling・mailbox同期を維持し、NES /IRQや追加GPIOは使わない。

## コアとメモリの役割

Core 0 は TinyUSB初期化・USB内部割り込み・MIDI解析・mailbox公開を担当する。
Core 1 は割り込みとSysTickを禁止し、既存 `src/poll_arm.S` の36B（literal含む）でROM応答だけを行う。
コードはSRAM bank 8、256Bの `rom256` はbank 9。ASMの命令列・GPIOマスク・SIO操作は変更していない。
Core 0はCore 1の起動を確認してからUSBを初期化する。PIO、DMA、NES割り込みは使わない。

SDK標準のCore 0スタックはbank 9を使うため、`src/usb_enter.S` でMSPを通常SRAMの
8KiB `usb_stack` へ移してからUSBへ進む。Core 1の起動用2KiB `rom_stack` も通常SRAMに置く。
これによりUSBの通常のスタック操作をROM用bank 9から分離する。mailbox公開時の短い共有アクセスは残る。

USB入力は4BのUSB MIDI event packetとして検証し、64件の共有FIFOへチャンネル番号付きの音源状態スナップショットを積む。
FIFOが満杯ならUSB入力を読み出さず、TinyUSBの512B RX FIFOとUSB OUTのbackpressureを使う。
Note On/Offの順序を保持し、最新状態だけへの置換やNote Offの黙示的な破棄は行わない。
NESが停止して処理できない間はホスト側まで待つ可能性がある。
USB unmount/suspend時は、Picoが動作し続けていれば保留分を4音源の消音コマンドに置き換える。
実行中のAPU書き込み列は完了させてから消音する。

## 256B ROM と更新プロトコル

| CPUアドレス | 内容 | 実行中の変更 |
|---|---|---|
| `$8000–$8039` | PPU/DMC/APU初期化、4音源を無音で有効化、SEI維持 | なし |
| `$8040–$8070` | READY待機、register/value列の反映、RELEASE待機 | なし |
| `$807F` | 未使用NMI/IRQベクタ先のRTI | なし |
| `$8080–$80AF` | register offset / valueのペア、最大24件 | データのみ更新 |
| `$80B0` | コマンド列のバイト数（ペア数×2） | データのみ更新 |
| `$80F0` | READY：コマンド列を公開したら1 | 0/1のみ |
| `$80F1` | RELEASE：APU反映の完了を確認したら1 | 0/1のみ |
| `$80FA–$80FF` | NMI/RESET/IRQベクタ | なし |

1. 6502は `LDA $80F0; BEQ ...` でREADYを繰り返し読む。初期READY/RELEASEはどちらも0。
2. Core 0は既存GPIO入力から、選択中の `$F0` 読み出しを観測する。RELEASEを0にし、
   ペア列とバイト数を書き終えてから **DSBバリア → READY=1** の順で公開する。
3. 6502はREADY=1を読み、各ペアを `LDA commands,X; TAY; LDA values,X; STA $4000,Y`
   で反映する。この間、Core 0はコマンド列を変更しない。
4. 反映後、6502は `LDA $80F1; BEQ ...` でRELEASEを繰り返し読む。
   Core 0がこの `$F1` 読み出しを観測すると、すべてのAPU書き込みが終わったと分かる。
5. Core 0は **READY=0 → DSBバリア → RELEASE=1** の順で6502を解放する。
6. 6502はREADY待機へ戻る。Core 0は再び `$F0` 読み出しを見るまで次の列を公開しない。

途中のペア列はREADY=0で隠す。READYを閉じてから解放するので同じ列を二重実行しない。
さらに、前のRELEASE待機を出る前にRELEASEを再度0にすると6502が停止してしまうため、
次の `$F0` を観測するまでは再公開しない。この帰還確認もプロトコルの必須条件。
両方の待機読み出しは繰り返すため、USB処理中に単発のバスサイクルを取り逃しても再観測できる。
固定時間待ち、NESからROMへの書き込み、外部ACK線には依存しない。

バイト数は0、奇数、48超を拒否し、register offsetは `$00–$17` だけを受理する。
6502コードとベクタは固定で、変更するのは上表のデータ領域だけ。
このmailboxは本ROM専用。NESリセット後はNote Onを再送する。

## 配線変更なしでの使用方法

既存の実機成功配線をそのまま使う。

| 信号 | Pico 2 GPIO |
|---|---|
| A0–A7 | GP0–GP7 |
| D0–D7 | GP8–GP15 |
| `/ROMSEL` | GP16とGP17の両方 |

MIDI版はGP0–17のみ初期化し、GP18/19やNES `/IRQ` は使用しない。追加ICも不要。
USB先行給電とNESを先にOFFにする順序は [既存配線条件](wiring.md) に従う。

```sh
# この作業環境ではTinyUSBも取得済み。別環境では最初に取得する。
git -C build-tools/pico-sdk submodule update --init lib/tinyusb
make check-midi
```

NES OFFでPico 2をBOOTSEL接続し、`build-midi/famidi.uf2` をUSBドライブへコピーする。
USBがLinuxへ公開されていれば `make flash-midi` でも書き込み・照合・起動できる。
Picoをflash bootさせてからNESをONにし、PC/DAWのMIDI出力先を `famidi Pulse 1`、チャンネルを1–4へ設定する。
MIDI keyboardを使う場合はPC/DAWでkeyboard入力をこの出力へルーティングする。
起動時は無音。以下の通常MIDIメッセージを順に送る。

| メッセージ（hex） | 確認内容 |
|---|---|
| `90 45 7F` | A4、最大Velocity。NTSCで約440.4Hz |
| `B0 07 40` | 音量8/15へ低下 |
| `E0 00 00` | 約2半音下がる |
| `E0 7F 7F` | 約2半音上がる |
| `E0 00 40` | 中央へ戻る |
| `80 45 00` | 消音 |
| `90 45 40` → `90 45 00` | 小さいVelocityで再発音し、Velocity 0で消音 |
| `91 48 7F` → `81 48 00` | Pulse 2でC5を発音・消音 |
| `92 45 7F` → `82 45 00` | TriangleでA4を発音・消音 |
| `93 04 7F` → `83 04 00` | Noise L4を発音・消音 |
| `93 44 7F` → `83 44 00` | Noise S4を発音・消音 |
| `B1 46 00` / `20` / `40` / `60` | Pulse 2 Duty 4種類（46はCC70のhex） |
| `B0 0B 00` → `B0 0B 7F` | Expression mute / 復帰 |
| `B0 78 00` … `B3 78 00` | 各音源のAll Sound Off |

ホストはこのMIDIメッセージをUSB event packetへパッキングする。例：Note Onは `09 90 45 7F`。
DAWの通常MIDI出力には先頭のCIN byteを付けない。

## 検証と実機で残る確認

`make check-midi` は実際のCエンジンをホスト用共有ライブラリへコンパイルし、py65と組み合わせて
MIDI解析、音量全組合せ、音程、FIFO満杯時の再試行、更新範囲、APU書き込みを検証する。
バイト単位の途中公開、完了確認の遅延、24ペアの最大長、不正長・不正registerの拒否、
観測をランダムに省略した200バッチの順序・重複防止も確認する。4音源の独立状態、Triangleのmute/復帰、Noise全128ノート、Duty/Sweep/Expressionも含め全26テスト。
さらにリンク済みC/ASM/MIDIの各版で1,281バス入力をUnicorn実行し、
MIDI版と既存ASM版の `.scratch_x` が36Bすべて一致することを確認する。
リンク後の起動コードもUnicornで実行し、Core 0 USB / Core 1 ROMの割り当て、USB用MSPの移動、
Core 1の割り込み禁止、GPIO初期化範囲がGP0–17だけであることを確認する。
この起動検証ではPLL設定とSDKのCore 1起動ハンドシェイクだけを模擬する。
SRAM配置・ROM256B一致・命令タイミングの結果は `build-evidence-midi/` に生成する。

固定音版と先行のch1 mailbox MIDI版はユーザーの実機で成功済み。
今回拡張した4音源版はビルド・エミュレーション検証済みで、4音源の実機音出しは未確認。
既存の73.3〜146.7nsは同じ命令列に対する競合なしのモデルであり、
Core 0のUSBとCore 1のROM応答が並行する今回の実機上界を保証する値ではない。
実機ではまず従来のch1 A4を確認し、次にch2・ch3・ch4、CC11/70、Poly和音とPadsを確認する。
Sweep ON/OFF、TriangleのVolume/Expression 0→1、4音源同時のCC連打と停止も確認する。
連続送信時もNote Offが残らないこと、二重発音やROM読み出しの乱れがないことを確認する。

APUレジスタと位相リセットの根拠：
[NESdev APU Pulse](https://www.nesdev.org/wiki/APU_Pulse)、
[APU Sweep](https://www.nesdev.org/wiki/APU_Sweep)、
[APU Triangle](https://www.nesdev.org/wiki/APU_Triangle)、
[APU Noise](https://www.nesdev.org/wiki/APU_Noise)。
USB実装はSDKが固定する [TinyUSB MIDI example](https://github.com/hathach/tinyusb/tree/86ad6e56c1700e85f1c5678607a762cfe3aa2f47/examples/device/midi_test)
の公開API・ディスクリプタ定義を参照。
