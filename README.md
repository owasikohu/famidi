# famidi: Pico 2 PRG-ROM replacement PoC

Raspberry Pi Pico 2 (RP2350A / Cortex-M33) で Mapper 0 カートリッジの
PRG-ROM を置換する最小実験です。A0–A7 だけで **256B を `$8000–$FFFF` に
ミラー**し、RESET 後に NES APU Pulse 1 で固定音を鳴らします。
PIO・割り込み処理・USB 通信・core 1 は使用しません。USB は先行給電だけに使用します。

**最適化ビルドと逆アセンブルを実施済み**です。150MHz、競合なしの命令タイミングモデルで、
同期・poll の取り逃しを含む SIO 出力確定までの遅延は C 版 **80–173.3ns**、
ASM 版 **73.3–146.7ns**。パッド・外部回路・基板の遅延は別です。
この数値だけで実機の安全性を保証することはできません。
標準NTSCのM2 Low209.5nsに対してASM解放上界126.7nsなので、通常の次CPU writeまで約82.9nsの余白があります。
固定ROMのPoCでは外部ゲート必須とはしません。非同期Hi-Z/5V出力を用意する最小案はバッファIC1個です。

- [配線・電源・外部ゲート](docs/wiring.md)
- [M2 Lowでの解放評価と1 IC最小配線](docs/minimal-poc.md)
- [コンパイル結果、命令別サイクル計算、NES タイミングとの比較](docs/timing.md)
- [C 版逆アセンブル](docs/evidence/c-loop.dis) / [ASM 版逆アセンブル](docs/evidence/asm-loop.dis)
- [命令別計算結果 JSON](docs/evidence/timing.json)

## ビルド

検証した構成: pico-sdk **2.2.0**、Arm GNU GCC **14.2.1**、`pico2`、
`rp2350-arm-s`、`Release` / `-O3`、定格 **150MHz**。
RISC-V 用コードではありません。Pico 2 の Cortex-M33 を明示的に使います。
ホスト側には CMake、Ninja、Python 3、C/C++ コンパイラ、
`arm-none-eabi-gcc/g++` と newlib / C++ ヘッダが必要です。
SDK は必要に応じて picotool 2.2.0 を取得・ビルドします。
TinyUSB サブモジュール未取得の警告は USB を無効にしている本構成では問題ありません。

```sh
git clone --branch 2.2.0 --depth 1 https://github.com/raspberrypi/pico-sdk.git ../pico-sdk
export PICO_SDK_PATH="$(cd ../pico-sdk && pwd)"

cmake -S . -B build-c -G Ninja -DPICO_BOARD=pico2 \
  -DPICO_PLATFORM=rp2350-arm-s -DCMAKE_BUILD_TYPE=Release
cmake --build build-c -j4

cmake -S . -B build-asm -G Ninja -DPICO_BOARD=pico2 \
  -DPICO_PLATFORM=rp2350-arm-s -DCMAKE_BUILD_TYPE=Release -DFAMIDI_ASM=ON
cmake --build build-asm -j4
```

生成物は各ビルドディレクトリの `famidi.elf`、`famidi.uf2`、`famidi.bin`、
`famidi.dis`、および `generated/rom256.bin` / `rom256.h` / `rom.lst` / `famidi.nes`。
UF2 の chip/family は **RP2350 ARM Secure** です。
BOOTSEL の書き込み時は NES を OFF にし、UF2 をコピー後は通常の flash boot に戻します。
BOOTSEL ROM の USB 書き込み機能はファームウェア実行中の USB 通信とは別です。

## 6502 ROM の生成

```sh
python3 tools/gen_rom.py --source rom/pulse.s --out build-rom
```

`rom/pulse.s` を小さな二段アセンブラで生成します。外部 6502 アセンブラは不要です。
対応する命令は SEI、CLD、LDX/LDA immediate、TXS、STA/JMP absolute、RTI、
`.org`、`.word`。未使用領域は NOP (`$EA`) で埋めます。
NMI/RESET/IRQ vector は末尾 `$FA–$FF` に置き、実際の `$FFFA–$FFFF` 読み出しでも
有効になります。RESET は `$8000`、割り込み先は RTI です。

Pulse 1 は 50% duty、constant volume 15、length halt、sweep 無効、timer 253。
NTSC 約 **440.4Hz**、PAL 約 **409.1Hz**。PPU rendering/NMI と DMC は無効にします。
`famidi.nes` は CPU/エミュレータ確認用の Mapper 0 イメージ
（256B を 16KiB に複製、blank 8KiB CHR）です。実カートリッジでは既存 CHR を残します。
MIDI 入力や画面描画はこの PoC の範囲に含まれません。

## 検証の再実行

```sh
python3 -m venv build-test-env
build-test-env/bin/pip install -r requirements-test.txt
build-test-env/bin/python -m unittest discover -s tests -v
build-test-env/bin/python tools/check_arm_loop.py \
  --c build-c/famidi.elf --asm build-asm/famidi.elf
python3 tools/analyze_timing.py \
  --c build-c/famidi.elf --asm build-asm/famidi.elf --out docs/evidence
```

CPU ROM テストは py65、実際にリンクした ARM ループの動作テストは Unicorn を使います。
後者は各版 **1,281 回の入力サンプル**を確認し、全256アドレス・選択状態の4組合せ・
選択中のアドレス連続変更・OUT→OE の順序・非選択時の OE clear を検証します。
Unicorn はタイミング測定器ではありません。APU の実音、NES/Pico 実機の動作、
オシロスコープ測定は未実施です。

このクラウド作業環境では SDK / toolchain は `/workspace/famidi-tools` にインストール済みです。
再利用する場合は以下を設定して上記コマンドを実行できます。

```sh
export PATH="/workspace/famidi-tools/arm/usr/bin:/workspace/famidi-tools/python/bin:$PATH"
export PYTHONPATH="/workspace/famidi-tools/python${PYTHONPATH:+:$PYTHONPATH}"
export PICO_SDK_PATH=/workspace/famidi-tools/pico-sdk
```
