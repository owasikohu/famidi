# コンパイル結果に基づく応答時間

本書の数値は元の固定音版の競合なしモデルです。固定音版は2026-10-15にユーザーから実機成功の報告を受けています。
USB MIDI版もASM命令列は同一ですが、Core 0のUSB処理とCore 1のROM応答の同時動作はこのモデルの範囲外です。
[MIDI版の検証と実機確認](usb-midi.md) を参照してください。

結論: **150MHz の SIO polling の命令処理時間は NES の読出し窓より短く、PoC としての
見込みはある。ただし SIO polling だけでバスの安全性を保証することはできない。**
ASM 化で応答を短縮しても、解除後の遅延と snapshot→OE_SET の race は残ります。
ただし固定ROMの通常のread→CPU writeは、M2 Low内に解放すれば成立します。
外部ゲート必須という以前の説明を修正し、[M2 Lowと解放時間の比較・1 IC案](minimal-poc.md) に条件を示しました。
実機の判定には、本体/基板遅延・driverの有効化時刻を含む測定が必要です。

## ビルドと配置の実証

2026-10-13 に pico-sdk 2.2.0 (`a1438dff1d38bd9c65dbd693f0e5db4b9ae91779`)、
GNU `arm-none-eabi-gcc` 14.2.1、CMake/Ninja、`Release -O3` で **C/ASM の両版を実際にリンク**。
ELF と RP2350 ARM Secure の UF2 を生成しました。SDK startup の default alarm pool は無効化し、
main で PRIMASK を設定、SysTick を停止します。USB/UART stdio は無効、core 1 を起動せず、
PIO/DMA は設定しません。SDK の boot/runtime 自体は使います。

| 対象 | ELF 上の実行/データアドレス | サイズ | 起動時 |
|---|---|---:|---|
| `rom_poll_c` | SRAM bank 8、`0x20080000` | 40B | `.scratch_x` の flash load image を SDK crt0 がコピー |
| `rom_poll_arm` | SRAM bank 8、`0x20080000` | 36B | 同上 |
| `rom256` | SRAM bank 9、`0x20081000` | **256B** | `.scratch_y` を SDK crt0 がコピー |

ROM が flash の `const` table のまま残っていないことを symbol/section と抽出バイナリで確認しました。
両ループは stack access / subroutine call / flash lookup がありません。
コードと ROM の SRAM bank を分け、instruction fetch と ROM lookup の同一 bank 競合を避けます。
main の stack は bank 9 ですが、応答ループ中は使用しません。
ループ内の SIO access は secure base `0xd0000000` に対する LDR/STR で、GPIO 高水準関数や
GPIO coprocessor instruction への置換はありません。

再生成:

```sh
arm-none-eabi-objdump -d --disassemble=rom_poll_c build-c/famidi.elf
arm-none-eabi-objdump -d --disassemble=rom_poll_arm build-asm/famidi.elf
python3 tools/analyze_timing.py \
  --c build-c/famidi.elf --asm build-asm/famidi.elf --out docs/evidence
```

[C 逆アセンブル](evidence/c-loop.dis)、[ASM 逆アセンブル](evidence/asm-loop.dis)、
[命令別の stall/branch/clock 計算と ELF/UF2 SHA256](evidence/timing.json) を保存しています。
コンパイラ/SDK/配置/オプションを変えたときは同じ値を流用せず再実行してください。

## 使用したクロック規則

根拠は [RP2350 datasheet release 8](https://datasheets.raspberrypi.com/rp2350/rp2350-datasheet.pdf)
（build 2026-10-01）の **3.7.4.9 Execution timing**。単純に「ARM 1命令=1clock」とは数えていません。
同節自体も「限られた非例外的な例を測定したもの」と明記しており、silicon/基板の WCET 保証ではありません。

- ALU / simple shift / UXTB は 1cycle。
- LDR/LDRB は 1cycle issue、結果をすぐ次で使う場合に **1cycle result-use stall**。
  `LDR GPIO_IN → TST`、`LDRB ROM → LSLS` で各1cycleを加算。
- STR は競合なしで 1cycle。store-data register は load-result penalty の source operand ではない。
- C 版 `TST.W #0x30000` は shifted modified-immediate で flags を設定するため、
  **さらに1cycle の必須 penalty**（3.7.4.9.2）。ASM は register mask の16bit TST にして除去。
- branch は 3.7.4.9.7 の式で計算:
  taken = `2 + L + U - (K & F)`、not-taken = `1 - F`。
  今回は L=0、target が16bit命令なので U=0。F は直前命令の長さ・word alignment・
  sequential execution・直前 folding から決め、K は flags producer を確認。
- C 版は UXTB と branch を fold: taken 1cycle、not-taken 0cycle。
  ASM の TST 直後の BNE は K=0: taken 2cycle、not-taken 0cycle。
  loop-end STR→B は fold して 1cycle。
  ASM idle の STR を word-align し、branch target の STR→B も fold 可能にした。

計算スクリプトの branch folding は、同データシート掲載の MOVS/SUBS/BNE ループ
（alignment により **299cycles / 300cycles**）を使ったテストとも一致しました。

前提は、単一 active core、DMA/IRQ/debug memory access なし、SRAM/SIO zero-wait access、
通常の命令 prefetch、clock 固定 150MHz。バス競合や fault を含む実機の絶対最悪時間ではありません。
電源投入/clock 設定/ROM コピーの時間は、USB 先行給電で RESET 解除前に完了させるため除外します。

## サンプルを検出してからデータを有効化する経路

開始は該当する `LDR GPIO_IN` の issue、終了は `STR GPIO_OE_SET` の完了とします。
`GPIO_OUT` はその1命令前に書くため、初回 read の出力 enable まで含めています。
既に出力中ならデータ更新は1命令前に終わりますが、表はその短縮に頼らない値です。

| 実際の経路 | 実行命令数 | clock | 150MHz での時間 |
|---|---:|---:|---:|
| C、idle 内側の sample が active を検出 | 8 | 10 | 66.7ns |
| C、active/外側 sample が active を検出 | 8 | 11 | 73.3ns |
| ASM、active 検出（idle/active 共通） | 8 | 9 | 60.0ns |
| C、idle poll 周期 | 5 | 7 | 46.7ns |
| C、active poll 周期 | 9 | 12 | 80.0ns |
| ASM、idle poll 周期 | 5 | 7 | 46.7ns |
| ASM、active poll 周期 | 9 | 10 | 66.7ns |

C の idle 応答経路の内訳は:

```
LDR(1) + load-use(1) + TST.W(1+1) + UXTB(1) + BNE not-taken(0)
+ LDRB(1) + load-use(1) + LSLS(1) + STR OUT(1) + STR OE_SET(1)
= 10cycles
```

C の外側 BEQ taken は 1cycle 加わり 11cycles。
ASM は TST の immediate penalty がなく、BNE not-taken が folded で 0cycle なので 9cycles。

## `/CE`・`/OE` 有効からの best / worst case

起点は **Pico 入力 pad の制御線が両方 Low かつアドレスが安定した時点**。
CPU/NES 側の元信号から測る場合は前段回路の遅延も別に足します。
`PROC_IN_SYNC_BYPASS=0` を維持しており、データシート 12.15.2 の規定に基づく
入力同期の2cyclesと、非同期 edge の最大1cycleの位相差を **2–3cycles** として加えます。
metastability の異常な延長を有限の絶対 worst case として保証するものではありません。

best は検出可能になった直後の sample が active を見る場合。
worst は sample を取り逃し、前の sample が active と判定していた長い経路を完了した後、
次の sample で更新する場合。idle 間に十分長く inactive が見えた場合だけを数えると過小評価になります。
連続 read で address が変わる場合、短い pulse を見落とした場合も長い経路を含めます。

| 版 | best 命令数 | worst 命令数（進行中の1sampleを含む） | best clock | worst clock の保守的上界 | 理論遅延 best–worst |
|---|---:|---:|---:|---:|---:|
| C `-O3` | 8 | 9+8=17 | 2+10=12 | 3+12+11=26 | **80.0–173.3ns** |
| 最小 ASM | 8 | 9+8=17 | 2+9=11 | 3+10+9=22 | **73.3–146.7ns** |

clock 表には synchronizer の待ち時間が含まれ、命令数には含まれません。
worst は位相と1poll周期をそれぞれ最大に置いた保守的上界で、全位相における tight な測定値ではありません。
初めから idle が確実に観測される場合の worst は C `(3+7+10)=20cycles=133.3ns`、
ASM `(3+7+9)=19cycles=126.7ns`。安全評価には上の長い active 経路を用います。

この値は **SIO register 側の出力有効化**までです。physical D0–D7 が receiver の電圧条件に
達する時刻には、GPIO 内部経路・pad slew・外部 translator・配線/負荷の遅延が残ります。
未測定のこの部分を0と扱って「実機の D 確定時間」を断言しません。

## 外部回路を含む NES の読出し窓との比較

[NESdev CPU pinout](https://www.nesdev.org/wiki/CPU_pinout) によると:

| CPU | CPU周期 | M2 High の読出し窓 |
|---|---:|---:|
| NTSC 2A03E/G/H | 約559ns、1.78977MHz | **約350ns**（15/24 duty） |
| PAL 2A07 | 約601ns、1.66261MHz | **約357ns**（19/32 duty） |
| 初期 NTSC 2A03 | 約559ns | 約396ns |

1CPU周期559ns全部を ROM access budget に使うことはできません。
[Cartridge connector](https://www.nesdev.org/wiki/Cartridge_connector) は address/R/W が M2 High
中に安定し、read data が M2 falling edge で valid である必要があること、
`/ROMSEL=NOT(M2 AND A15)` であることを説明しています。
CPU data setup、`/ROMSEL` decode、board skew、data hold/turnaround の余裕を含めて評価します。
本体 revision に共通する「ROM access は必ず N ns 以下」という保証値は、この資料からは得られません。
現代の CMOS W65C02 の setup time をそのまま RP2A03 に流用してはいけません。

配線表の TI **SN74LVC8T245** は VCCA=3.3±0.3V / VCCB=5±0.5V の表5.9で
A→B `tPD=0.5–4.4ns`、B output enable 最大6.8ns、disable 最大6.3ns。
これらは表6の5V出力負荷 **CL=15pF / RL=2kΩ**での仕様。実NESの負荷に無条件に適用しません。
**SN74LVC1G332** の OR gate は3.3V、50pF、−40～85°C条件で最大4.8ns。
gate enable path は最大 `4.8+6.8=11.6ns` で software 応答と**並列**に進むため、
software の末尾へ常に直列加算する経路ではありません。
GP data が駆動を始めた後の translator data path は最大4.4nsを加算します。

`δIO` を未測定の GPIO/pad/配線遅延、`δDEC` を M2→`/ROMSEL` 等の前段遅延、
`tDSU` を CPU に必要な setup time とすると、NTSC の成立条件は保守的に:

```
C:   173.3 + 4.4 + δIO + δDEC + tDSU < 350 ns
ASM: 146.7 + 4.4 + δIO + δDEC + tDSU < 350 ns
```

C は残り **172.3ns**、ASM は **198.9ns** の枠に未知の遅延/setup/marginを収める必要があります。
PAL の枠は各7ns増えます。例えば設計目標として「ROM応答200ns以内」を置くなら、
C の未測定 `δIO` の残り枠は22.3ns、ASMは48.9nsです。この **200ns は比較用の設計目標**であり、
全 NES が保証する契約値ではありません。
入力に LVC244A を追加する場合、該当条件の最大5.9ns（−40～85°C、3.3V）も前段に加えます。

したがって命令経路が数百ns～µsになって窓を明白に超過する状態ではなく、
ASM 化後は C より26.7nsの worst-case余裕があります。ただしこれは
**バッファ/本体/基板の条件が成立すれば read response を満たせる**という評価です。
無測定での「SIOだけで安全」の結論にはなりません。

## 非選択時の解放と race

SIO だけの場合の `GPIO_OE_CLR` 完了までの上界も計算しました:

| 版 | inactive を検出した経路 | active sample 直後に解除される場合 |
|---|---:|---:|
| C | 5命令 / 6cycles | 3+12+6=21cycles = **140ns** + pad遅延 |
| ASM | 4命令 / 6cycles | 3+10+6=19cycles = **126.7ns** + pad遅延 |

この間に別の driver が有効になると直結バスでは衝突し得ます。
制御線をもう一度読む方式にも「最後の判定の直後に解除」の窓が残るため、完全解決ではありません。
外部 OR→U1 の disable path は `/CE` または `/OE` の解除から最大
`4.8+6.3=11.1ns`（指定された IC の負荷/電圧/温度条件下）で、SIO の応答と独立です。
CPU R/W から `/OE` を生成する U2 の遅延、CPU data hold、次の bus driver の開始時刻も評価してください。
ゲートでも有限の disable delay はあるので、hold/turnaround の実機確認を省略できません。

## 実施済みと実機で残る確認

実施済み: 最適化 C/ASM ビルド、UF2 family/metadata 確認、SRAM配置/256B一致確認、
branch timing の公式例との照合、6502 reset/APU register write/infinite loop の CPU emulation、
各 ARM 版1,281入力サンプルの instruction emulation。
APU 合成器や NES のアナログ音声回路までエミュレートしたわけではありません。

実機では `/ROMSEL`、`/OE`、M2、CPU R/W、A0–A7、NES D0–D7 を観測し、
全 address/data pattern と連続 read・read→write・write→read の各遷移で、
falling M2 に対する D setup/hold と bus contention を測ります。
入力同期と sample の位相を掃引できる CPU bus pattern generator、または実機で十分なサンプル数を
用意し、温度/供給電圧/負荷も含めて確認します。
確認後に固定配線・clock・ビルド条件で PoC 可否を判断してください。

## 参照資料

- [RP2350 datasheet](https://datasheets.raspberrypi.com/rp2350/rp2350-datasheet.pdf):
  release 8、3.1 SIO、3.7.4.9 execution timing、4.2 SRAM、12.15.2 input sync、
  electrical specifications / fault-tolerant pad、D.5.1 E9。
- [NESdev CPU pinout](https://www.nesdev.org/wiki/CPU_pinout) / [Cartridge connector](https://www.nesdev.org/wiki/Cartridge_connector)。
- [TI SN74LVC8T245](https://www.ti.com/lit/ds/symlink/sn74lvc8t245.pdf): SCES584D、表5.9、VCC isolation/Ioff。
- [TI SN74LVC1G332](https://www.ti.com/lit/ds/symlink/sn74lvc1g332.pdf): OR gate switching characteristics。
- [TI SN74LVC1G00](https://www.ti.com/lit/ds/symlink/sn74lvc1g00.pdf): R/W inverter（NAND両入力を接続）。
- [TI SN74LVC244A](https://www.ti.com/lit/ds/symlink/sn74lvc244a.pdf): オプションの入力バッファ。
