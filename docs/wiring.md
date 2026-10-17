# 配線と電源

IRQなしUSB MIDI版は実機PoCの配線を維持します：A0–A7=GP0–7、D0–D7=GP8–15、
GP16/17は両方 `/ROMSEL`。GP18/19やNES `/IRQ`、追加ICは使いません。
詳細は [USB MIDIの配線と確認手順](usb-midi.md) を参照してください。
以下のGP18を含む3 IC案は元の固定音PoC向けの参考構成です。

対象は **Mapper 0 の PRG-ROM 置換**です。CPU が ROM read するときだけ新しい回路が
CPU D0–D7 を駆動します。元の PRG-ROM は取り外すか、そのチップの出力を確実に無効化してください。
元の ROM と並列に有効化すると bus conflict になります。CHR-ROM、CIRAM/mirroring、
PPU 配線、音声経路は元のカートリッジ/本体のものを残します。

IC数を優先する固定ROM実験には [0 ICの成立条件・1 IC配線](minimal-poc.md) を参照してください。
以下はR/Wをハードウェアでqualifyする元の3 IC案です。固定ROMのPoCに3 ICが必須という意味ではありません。

## GPIO と Pico 2 の物理ピン

GPIO 番号と基板の物理ピン番号は異なります。A0–A7、D0–D7、制御線を GP0–GP18 に連続配置します。

| NES / 回路側信号 | Pico GPIO | Pico 2 物理ピン | 接続・方向 |
|---|---:|---:|---|
| CPU A0 | GP0 | 1 | NES → Pico、直接入力 |
| CPU A1 | GP1 | 2 | NES → Pico、直接入力 |
| CPU A2 | GP2 | 4 | NES → Pico、直接入力 |
| CPU A3 | GP3 | 5 | NES → Pico、直接入力 |
| CPU A4 | GP4 | 6 | NES → Pico、直接入力 |
| CPU A5 | GP5 | 7 | NES → Pico、直接入力 |
| CPU A6 | GP6 | 9 | NES → Pico、直接入力 |
| CPU A7 | GP7 | 10 | NES → Pico、直接入力 |
| CPU D0 | GP8 | 11 | GP8 → U1 A1、U1 B1 → CPU D0 |
| CPU D1 | GP9 | 12 | GP9 → U1 A2、U1 B2 → CPU D1 |
| CPU D2 | GP10 | 14 | GP10 → U1 A3、U1 B3 → CPU D2 |
| CPU D3 | GP11 | 15 | GP11 → U1 A4、U1 B4 → CPU D3 |
| CPU D4 | GP12 | 16 | GP12 → U1 A5、U1 B5 → CPU D4 |
| CPU D5 | GP13 | 17 | GP13 → U1 A6、U1 B6 → CPU D5 |
| CPU D6 | GP14 | 19 | GP14 → U1 A7、U1 B7 → CPU D6 |
| CPU D7 | GP15 | 20 | GP15 → U1 A8、U1 B8 → CPU D7 |
| `/CE` = カートリッジ `/ROMSEL` | GP16 | 21 | NES → Pico と U3 入力、直接入力 |
| `/OE` = NOT(CPU R/W) | GP17 | 22 | U2 出力 → Pico と U3 入力 |
| INHIBIT（High = 出力禁止） | GP18 | 24 | Pico → U3 入力、10kΩで Pico 3V3 に pull-up |
| 共通 GND | GND | 3 等 | NES GND、Pico GND、全 IC GND を共通化 |
| Pico 3V3 OUT | — | 36 | U1 VCCA、U2/U3 VCC、INHIBIT pull-up |
| NES +5V | — | — | U1 VCCB のみ。Pico 3V3/VSYS/VBUS と直結しない |

CPU A8–A14 は未接続、A15 は直接読みません。`/ROMSEL` が `$8000–$FFFF` を選択します。
NES 72pin と Famicom 60pin はコネクタ配置が異なるため、
[Cartridge connector](https://www.nesdev.org/wiki/Cartridge_connector) と基板の導通で信号名を確認してください。
CPU の controller-port `/OE1` / `/OE2` はこの ROM の `/OE` とは別信号です。

## R/Wをqualifyする外部回路（3 IC案）

| 部品 | 電源 | 接続 |
|---|---|---|
| U1: TI **SN74LVC8T245** | VCCA=Pico 3.3V、VCCB=NES 5V | A1–A8=Pico D0–D7、B1–B8=NES D0–D7、DIR=VCCA（A→B 固定） |
| U2: TI **SN74LVC1G00** | Pico 3.3V | 両 NAND 入力を CPU R/W に接続、出力を `/OE` とする |
| U3: TI **SN74LVC1G332** | Pico 3.3V | 3入力 OR: `/ROMSEL`、`/OE`、INHIBIT。出力を U1 `/OE` に接続 |

```
/CE           = /ROMSEL = NOT(M2 AND CPU_A15)   （本体で生成済み）
/OE           = NAND(R/W, R/W) = NOT(R/W)       （U2）
U1 /OE        = /CE OR /OE OR INHIBIT           （U3）
U1 出力有効   = M2 AND CPU_A15 AND R/W AND NOT(INHIBIT)
```

`/ROMSEL` は read/write の両方で low になるので、R/W qualification は必須です。
`/ROMSEL` 自体が M2 を含むため、U2 に M2 を重ねる必要はありません。
U3 は GPIO のソフトウェア読出し結果ではなく、**実際の線**を直接入力とします。
各 IC に 100nF の decoupling、U1 の両電源にそれぞれ 100nF を設置してください。
GP8–GP15/U1 A 入力には各 47kΩ pull-down を置き、Pico が Hi-Z の間の浮遊入力を防ぎます。
部品のパッケージごとの端子配置は各データシートで確認してください。

U1 は 3.3→5V の出力変換に加え、VCC isolation と Ioff を備えています。
NES が OFF（VCCB=0）の間に USB/Pico 側だけが ON でも、NES 側への駆動を遮断します。
一般的な抵抗分圧、BSS138 の自動双方向モジュール、DIR 自動検出の translator では代用しないでください。
USB の VBUS と NES の +5V を束ねず、GND だけを共通にします。

## USB 先行給電の条件

[RP2350 データシート](https://datasheets.raspberrypi.com/rp2350/rp2350-datasheet.pdf)
release 8 の 5V-tolerant/fault-tolerant pad の規定では、**IOVDD=3.3V の給電中**に
今回の GP0–GP18 は 5V 入力を受けられます。未給電時の failsafe は **3.3V** までです。
「いつでも5V耐圧」ではありません。ADC GPIO など別の pad 種別に配線を移してはいけません。

1. NES OFF で接続/書き込みを行う。
2. Pico の USB を給電して flash boot し、GP18=Low かつ polling 動作開始を確認する。
3. NES を ON、または NES RESET を解除する。
4. 停止時は **NES を先に OFF**、その後に USB を外す。

Pico の USB 通信はアプリから初期化しません。USB 電源の節電・抜去・Pico reset/reflash を
NES ON のまま行わないでください。順序を保証できない場合は A0–A7 と `/CE` に
SN74LVC244A（Pico 3.3V 給電、5V tolerant input、Ioff 対応）の入力バッファを追加し、
給電遮断中の安全性も設計してください。追加したバッファの遅延は timing budget に加算します。

RP2350 A2 の E9 対策として、本コードはデータ出力と INHIBIT の IE を無効化し、
入力は内部 pull-down に頼らず CPU/U2 から駆動します。未接続状態の入力値は保証しません。

## Hi-Z の保証範囲

C/ASM とも、選択中に `GPIO_OUT` を先に更新してから `GPIO_OE_SET`、非選択を検出したら
`GPIO_OE_CLR` を書きます。ただし polling のため **Pico GP8–GP15 が Hi-Z になるまでには遅延**があります。
選択を読み取った直後に解除されると、古い sample に基づく OE_SET も起こり得ます。
この窓を C の追加条件判定だけで完全に消すことはできません。

U3/U1 により、**NES 側 D0–D7** は非 ROM read で非同期に Hi-Z へ戻ります
（有限の gate/disable propagation delay は残ります）。本構成では U1 を一方向に固定するので、
NES CPU が RAM/APU 書き込みでバスを駆動しても Pico へ逆向き出力されません。
SIO polling だけの直結構成には、この非同期 Hi-Z 保証がありません。
CPU の data-hold と次の driver までの turnaround も実機で確認する必要があります。
