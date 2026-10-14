# NTSC の M2 Low と最小部品 PoC

**固定音ROMの通常の ROM read→APU/PPU write について、外部ゲートを必須とする根拠はありません。**
ASM の解放時間を M2 Low に収めれば、次の CPU write driver が有効になる前に Pico を Hi-Z にできます。
以前の「解除後の polling 遅延があるので必ず外部ゲートが必要」という説明は、この余白を評価しておらず強すぎました。
一方、read期間以外の非同期 Hi-Z と5V出力を用意するなら、固定ROMに限定して **バッファIC 1個**にできます。
元の [3 IC構成](wiring.md) は任意のROM writeも禁止する構成として残します。

## 解放時間と M2 Low の定量比較

根拠は [NESdev CPU pinout](https://www.nesdev.org/wiki/CPU_pinout) の M2 duty と、
実際にコンパイルした [ASM逆アセンブル](evidence/asm-loop.dis) / [命令計算](evidence/timing.json)。
CPU周期は NTSC master 21.477272MHz / 12 から **558.73ns**。
「NTSC 2A03」には少なくとも以下の違いがあるため、無印も別に示します。

| CPU | M2 High | M2 Low | ASM 解放上界 | Low の残り枠 |
|---|---:|---:|---:|---:|
| 2A03E/G/H、15/24 duty | 349.21ns | **209.52ns** | **126.67ns** | **82.86ns** |
| 初期の無印2A03、17/24 duty | 395.77ns | **162.96ns** | **126.67ns** | **36.30ns** |

解放上界は、選択を取り込んだ直後に `/ROMSEL` が High になり、古い active sample に基づいて
OE_SET する最も長い経路も含む:

```
入力同期・位相      3cycles
前の active poll   10cycles
inactive 検出→CLR   6cycles
合計              19cycles / 150MHz = 126.67ns
```

同期/競合なし等の前提と pad 遅延の除外は元の命令評価と同じです。
`δDEC↑` を M2 falling→`/ROMSEL` High の本体decode遅延、`δDIS` を Pico pad の解放/経路遅延とすると、
次の M2 rising までに直接接続のデータを解放する条件は:

```
2A03E/G/H: δDEC↑ + δDIS < 82.86ns
無印2A03:  δDEC↑ + δDIS < 36.30ns
```

CPU write data は内部 φ2 High で駆動されるので、ここでは保守的に **次の M2 risingまで**を deadline とした。
read→write の移行時に同じ driver が M2 Low の始めから直ちに書き込みを駆動する、とは扱わない。
標準E/G/Hには約83nsの残り枠があり、正常な固定ROM実験では0 IC直結を検討できる。
無印は残り枠が小さいため、同じ安心度とみなしてはいけない。
ただしこの比較は未知の本体/pad遅延を測定したものではなく、全 clone、DMA、別の拡張回路、
M2で選択をqualifyしない追加driver、非同期のreset/給電障害まで保証するものでもない。
3.3V出力を2A03入力が認識する電圧条件も、直結評価に必要。

固定ROMは `$2000/$2001/$4000–$4017` にだけ書き、`$8000–$FFFF` には書かない。
SEI、PPU NMI無効、DMC無効、OAM DMA未使用、通常ループの命令fetchはすべてROM。
この限定された read→I/O-write の可否と、「任意のバスアクセスで read以外は非同期にHi-Z」という
一般的な保証は別の要件である。直結は `/ROMSEL` High 後にも最大126.67ns程度出力を保持する。

## PoC推奨: TI SN74LVC8T245DW を1個

最小の非同期出力ゲート兼3.3→5V変換として **TI SN74LVC8T245DW（24pin SOIC）**を選ぶ。
追加のNAND/OR/反転ICは使わず、`/ROMSEL` を U1 の `/OE` へ直接接続する。
TI [SCES584D](https://www.ti.com/lit/ds/symlink/sn74lvc8t245.pdf) の表5.3は control input の
入力電圧0–5.5V、VCCA=3.0–3.6Vの VIH=2.0V / VIL=0.8Vを規定している。
**閾値がVCCA基準であることと、5V信号を入力できないことは同義ではない。**
この具体的部品では `/ROMSEL` を分圧・反転せず入力できる。他のdual-supply品に無条件に流用しない。

| U1 信号 | DW端子番号 | 接続 |
|---|---:|---|
| VCCA | **1** | Pico 3V3 OUT |
| VCCB | **23, 24** | NES +5V（両方を接続） |
| GND | **11, 12, 13** | 共通GND（すべて接続） |
| DIR | **2** | Pico 3V3へ固定、A→B |
| `/OE` | **22** | カートリッジ `/ROMSEL` へ直結 |
| A1–A8 | **3–10** | Pico GP8–GP15（D0–D7） |
| B1–B8 | **21–14**（逆順） | NES CPU D0–D7 |

VCCA/VCCBの各railへ100nF、A1–A8に各47kΩ pull-downを置く。
必要なら `/OE` のpull-upは10kΩで **NES +5V** へ置く。Pico側3.3Vから未給電の本体へpull-upしない。
USB先行給電時のVCCB=0は U1 の VCC isolation/Ioff がB側をHi-Zにする。
USBを先に入れ、NESを先に切る電源順序は変わらない（直接接続のアドレス/制御入力を保護するため）。

ファームウェアを変更せずに使う配線:

```
NES A0..A7 ─────────────────────── Pico GP0..GP7
                  ┌────────────── Pico GP16 (/CE)
NES /ROMSEL ──────┼─────────────── Pico GP17 (/OE sample)
                  └────────────── U1 pin22 (/OE)
Pico GP8..GP15 ── U1 A1..A8 ──[A→B]── U1 B1..B8 ── NES D0..D7
Pico GP18 (旧INHIBIT) ── 未接続（readyの観測には使える）
```

GP16とGP17は同じ `/ROMSEL` に接続する。既存のC/ASMは両方Lowで応答するため、命令列・clockは変わらない。
GP18の外部ゲート接続とpull-upは不要。R/W反転用 U2 と OR用 U3 を取り除く。

**重要な適用限界:** `/ROMSEL` は ROM read **とROM write** の両方でLowになる。
この1 IC構成はROM writeをハードウェアで識別しない。既存 `pulse.s` のようにROM writeが一切ないPoCに限定する。
GPがHi-Zでも、U1の `/OE` がLowならU1は入力のpull-down値をNES側へ出力するため、
「GPIOをHi-ZにするだけでROM write時も安全」と考えてはいけない。
任意の6502プログラムへ拡張する場合は R/W を含む qualification が必要。
Pico未起動/停止中にNESを走らせることも本構成の動作条件外。

## `/ROMSEL` Low → read data valid の再計算

以下のIC数値は SCES584D 表5.9、VCCA=3.3±0.3V / VCCB=5±0.5V、−40～85°C、
**表6の5V出力負荷 CL=15pF / RL=2kΩ**での値。
NESバスの実負荷が15pFを超える場合、このmax値をそのまま実機上界にしてはいけない。
出力波形の測定、またはその負荷で仕様が得られる部品の評価が必要。

| U1の経路 | min | max |
|---|---:|---:|
| A→B data propagation | 0.5ns | **4.4ns** |
| `/OE`→B enable | 0.9ns | **6.8ns** |
| `/OE`→B disable | 0.8ns | **6.3ns** |

外部enableはsoftwareと並列なので、enable遅延を丸ごとsoftwareの後に足す計算にはしない。
`δIO` はPico input/output pad、配線、rise/fall、receiver閾値へ到達するまでの追加分をまとめた未測定量とする。

```
tVALID = max(tEN, tPico + tPD) + δIO
```

**条件を増やさない元の保守的上界**（前sampleがactiveの可能性を残す）:

```
best:  73.33 + 0.5 = 73.83ns + δIO
worst: max(6.8, 146.67 + 4.4) = 151.07ns + δIO
```

**NTSC M2 Lowで毎回idleへ戻ると確認できる場合**は、次readに長いactive経路は持ち越されない。
ASMの解放CLRまで126.67ns、続くreturn branchを含めて133.33ns以内にidle sampleへ戻れる。
本体decode/位相skewを含む実際の `/ROMSEL` High幅がこれより長いことを確認すると:

```
次readのPico上界 = (同期3 + idle poll7 + read response9) / 150MHz
                 = 19cycles = 126.67ns
tVALID,worst     = max(6.8, 126.67 + 4.4) = 131.07ns + δIO
```

E/G/HのM2 Low209.52nsに対してidle returnの残り枠は **76.19ns**。
無印の162.96nsでは **29.63ns**。条件を確認するまでは151.07nsの方を採用する。
M2 High349.21nsのE/G/Hでは、M2→`/ROMSEL` Low の遅延を `δDEC↓`、CPU setupを `tDSU` として:

```
一般上界: δDEC↓ + δIO + tDSU < 349.21 - 151.07 = 198.14ns
idle確認後: δDEC↓ + δIO + tDSU < 349.21 - 131.07 = 218.14ns
```

U1でのbus releaseは `/ROMSEL` High から最大 **6.3ns**（上の試験条件）で、Picoの126.67nsを待たない。
CPU data hold、実負荷のdisable/settling、decoder最短遅延も別途確認する。
結論は **正常なCPU write移行だけなら0 ICも条件付きで可能、PoCの非同期Hi-Z/5V出力には1 ICで足りる**。
全accessに対するR/W qualificationまで要求する場合の1 IC案ではない。
