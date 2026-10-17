# famidi: Pico 2 PRG-ROM replacement PoC

Raspberry Pi Pico 2 (RP2350A / Cortex-M33) で Mapper 0 カートリッジの
PRG-ROM を置換する最小実験です。A0–A7 だけで **256B を `$8000–$FFFF` に
ミラー**します。従来の固定音版に加え、USB MIDI → ROM内mailbox → 6502のAPU書き込み による4音源実装とWeb MIDI Consoleを追加しました。
固定音版の `rom/pulse.s` と ASM polling の命令列は維持しています。
固定音版はユーザー環境で実機動作確認済み（2026-10-15）。先行のIRQなしch1 MIDI版も実機成功済みです。今回の4音源拡張は実機未確認です。

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
- [配線変更なしのUSB MIDI・mailbox同期・動作確認](docs/usb-midi.md)

## USB MIDI 版

USB MIDI 1.0 device として `famidi Pulse 1` を公開します。MIDI ch1=Pulse 1 / ch2=Pulse 2 / ch3=Triangle / ch4=Noise。
Note On/Off、Velocity、Pitch Bend（音程音源±2半音）、CC7 Volume、CC11 Expression、
PulseのCC70 Duty・CC13–16 Sweep、Program Change、各chのCC120/121/123に対応します。
Webアプリを開かずにDAW等から通常のUSB MIDI音源として使えます。
core 0 は TinyUSB とコマンド生成、core 1 は既存の ASM polling を担当します。
6502はROM内のregister/value列をpollし、`$4000–$4017`へ反映します。
**NES /IRQ、追加GPIO、追加ハードは使用しません。**

構築済みローカル環境では以下で利用できます。

```sh
make build-midi  # build-midi/famidi.uf2 を生成
make check-midi  # 全26テスト、3版のARMループ検証、コア配置・GPIO・ASM一致確認
make flash-midi  # NES OFF、Pico 2をBOOTSEL接続して実行
```

**既存の実機PoC配線のまま**使えます。A0–A7=GP0–7、D0–D7=GP8–15、
GP16/17は両方 `/ROMSEL` です。USBをPCに接続し、DAW等からMIDI ch1–4を送ってください。USBの表示名は従来どおりです。
最短の確認手順と同期方式は [USB MIDI](docs/usb-midi.md) を参照。

### ブラウザからMIDIキーボードで演奏

[Web MIDI Console](web-midi/README.md) を追加しました。
[本人専用のUIを開く](https://famidi-midi-console.rockygnome512.chatgpt.site)。
`make web` で起動し、Chrome / Edgeで `http://localhost:8080` を開きます。
「MIDIに接続」でアクセスを許可し、入力にMIDIキーボード、出力に `famidi Pulse 1` を選ぶと演奏できます。
Original互換（ch維持）/ Mono / 3-voice Polyを切り替え、PolyはPulse 1・Pulse 2・Triangleへ割り当てます。
Oxygen 25開始用プリセット、GUIから編集できるCC・Pad→Noise割当、
外れ値除去・平滑化・ヒステリシスとPulse音量16段階化を備えます。
入力/出力MIDI monitor、画面/PC鍵盤、移調、全音停止、localStorage設定保存も利用できます。
テストは `make web-test`。実機で4音源を使うには新しい `build-midi/famidi.uf2` の書き込みが必要です。

## ビルド

検証した構成: pico-sdk **2.2.0**、Arm GNU GCC **14.2.1**、`pico2`、
`rp2350-arm-s`、`Release` / `-O3`、定格 **150MHz**。
RISC-V 用コードではありません。Pico 2 の Cortex-M33 を明示的に使います。
ホスト側には CMake、Ninja、Python 3、C/C++ コンパイラ、
`arm-none-eabi-gcc/g++` と newlib / C++ ヘッダが必要です。
SDK は必要に応じて picotool 2.2.0 を取得・ビルドします。
固定音版は USB 通信・core 1 を使用しません。MIDI 版では SDK の `lib/tinyusb` が必要です。

```sh
git clone --branch 2.2.0 --depth 1 https://github.com/raspberrypi/pico-sdk.git ../pico-sdk
export PICO_SDK_PATH="$(cd ../pico-sdk && pwd)"

cmake -S . -B build-c -G Ninja -DPICO_BOARD=pico2 \
  -DPICO_PLATFORM=rp2350-arm-s -DCMAKE_BUILD_TYPE=Release
cmake --build build-c -j4

cmake -S . -B build-asm -G Ninja -DPICO_BOARD=pico2 \
  -DPICO_PLATFORM=rp2350-arm-s -DCMAKE_BUILD_TYPE=Release -DFAMIDI_ASM=ON
cmake --build build-asm -j4

# USB MIDI 版
git -C "$PICO_SDK_PATH" submodule update --init lib/tinyusb
cmake -S . -B build-midi -G Ninja -DPICO_BOARD=pico2 \
  -DPICO_PLATFORM=rp2350-arm-s -DCMAKE_BUILD_TYPE=Release \
  -DFAMIDI_ASM=ON -DFAMIDI_USB_MIDI=ON
cmake --build build-midi -j4
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
対応する命令は SEI/CLI、CLD、LDX/LDA immediate、LDA absolute、TXS、
STA/JMP/CPX absolute、LDA absolute,X、STA absolute,Y、CMP/AND immediate、
TAY/INX、PHA/PLA、BEQ/BNE/BCS relative、RTI、
`.org`、`.word`。未使用領域は NOP (`$EA`) で埋めます。
NMI/RESET/IRQ vector は末尾 `$FA–$FF` に置き、実際の `$FFFA–$FFFF` 読み出しでも
有効になります。固定音版では RESET は `$8000`、割り込み先は RTI です。
MIDI版では `rom/midi.s` を使い、SEIを維持した固定プログラムがmailboxをpollします。
実行中に6502命令を書き換えず、データ領域だけを更新します。

Pulse 1 は 50% duty、constant volume 15、length halt、sweep 無効、timer 253。
NTSC 約 **440.4Hz**、PAL 約 **409.1Hz**。PPU rendering/NMI と DMC は無効にします。
`famidi.nes` は CPU/エミュレータ確認用の Mapper 0 イメージ
（256B を 16KiB に複製、blank 8KiB CHR）です。実カートリッジでは既存 CHR を残します。
画面描画は実装していません。MIDI 版の iNES は静的な起動イメージのため、
通常の NES エミュレータだけでは RP2350 の動的更新を再現しません。

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
Unicorn はタイミング測定器ではありません。固定音版はユーザーから実機成功の報告を受けています。
先行ch1 MIDI版はUSB列挙・音出しも実機成功済みです。
今回の4音源拡張の音出しと、オシロスコープによるタイミング測定は未確認です。

ローカル環境の構築・コードの担当箇所・実機への書き込み手順は
[開発環境](docs/development.md) を参照してください。
依存関係を `build-tools/` と `build-test-env/` に配置した環境では、環境変数の設定なしで実行できます。

```sh
make build       # C/ASM 両版の ELF / UF2 / ROM を生成
make check       # 固定音版ビルド、全テスト、タイミング解析、ARMループ検証
make info        # UF2 の対象チップ・配置を表示
```
