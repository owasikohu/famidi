# ローカル開発環境

## 構成と変更箇所

対象は Pico 2 / RP2350 の Cortex-M33、150MHz、Mapper 0 の PRG-ROM 置換。
256B の ROM を `$8000–$FFFF` にミラーし、6502 のプログラムが APU Pulse 1 を鳴らす。
固定音版に加えて、USB MIDI ch1–4 → mailbox polling → Pulse 1/2・Triangle・Noiseを実装した。
[USB MIDIの仕様と手順](usb-midi.md) を参照。画面描画は実装していない。

| ファイル | 役割 |
|---|---|
| `src/main.c` | クロック・GPIO 初期化と C polling。コードは SRAM bank 8、ROM は bank 9 |
| `src/poll_arm.S` | `FAMIDI_ASM=ON` で使う ARM polling。GPIO の同一サンプルから選択状態とアドレスを取得 |
| `rom/pulse.s` | NES CPU が実行する 6502 コード。APU 初期化、固定音、割り込みベクタ |
| `rom/midi.s` | MIDI版の256B ROM。SEIを維持しmailboxのregister/value列をpoll |
| `src/midi_engine.c` | MIDI解析、音量・音程、FIFO、APU register/value列、mailbox同期 |
| `src/usb_midi.c`, `src/usb_descriptors.c`, `src/tusb_config.h` | core 0上のTinyUSB MIDI device |
| `tools/gen_rom.py` | 小型 6502 アセンブラ。256B ROM、C ヘッダ、リスト、iNES を生成 |
| `src/usb_enter.S` | Core 0のMSPを通常SRAMへ移してUSB処理へ移行 |
| `tools/check_arm_loop.py` | リンク済み C/ASM ループを Unicorn で実行し、SIO の入出力を検証 |
| `tools/analyze_timing.py` | 逆アセンブルから配置・命令経路・タイミングを解析 |
| `web-midi/dist/` | Web MIDIルーティング、声の割当、CCフィルタとGUI、設定保存 |
| `web-midi/tests/` | NodeテストとPlaywrightによるMIDIポート模擬UI検証 |
| `tests/` | MIDIエンジン・6502 mailbox実行、既存ROM・タイミングを含む26テスト |
| `CMakeLists.txt` | SDK、ROM 自動生成、C/ASM 切り替え、UF2 出力の定義 |
| `docs/evidence/` | 以前の検証記録。ローカルの解析結果は `build-evidence/` に出す |
| `docs/wiring.md`, `docs/minimal-poc.md`, `docs/timing.md` | 配線、最小構成の条件、命令タイミングの前提 |

`rom/pulse.s` の変更は次のビルドで自動反映される。
応答ループ・コンパイラ・SDK・クロックを変更した場合は `make check` で再評価する。
GPIO 配置やループの構造を変える場合は、ARM 検証・タイミング解析側の前提も更新する。

## 用意した環境

2026-10-15、WSL2 / Linux x86_64 で構築。
依存関係と生成物は既存の `.gitignore` の `/build*/` に含まれる。

| ツール | バージョン / 配置 |
|---|---|
| Pico SDK | 2.2.0、`build-tools/pico-sdk`、commit `a1438dff1d38bd9c65dbd693f0e5db4b9ae91779` |
| ARM GCC | 14.2.1 / Arm GNU Toolchain 14.2.Rel1、`build-tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi` |
| picotool | 2.2.0、`build-tools/picotool/bin/picotool`、libusb 対応 |
| Python | 3.12.3、仮想環境 `build-test-env` |
| テスト依存 | py65 1.2.0、Unicorn 2.1.4 |
| ホストビルド | CMake 3.28.3、Ninja 1.11.1、GNU Make 4.3、GCC/G++ 13.3.0 |

ARM GCC は [Arm の公式配布](https://developer.arm.com/Tools%20and%20Software/GNU%20Toolchain)
から取得し、配布された SHA256 と照合済み。
アーカイブの SHA256 は `62a63b981fe391a9cbad7ef51b17e49aeaa3e7b0d029b36ca1e9c3b2a9b78823`。
SDK の TinyUSB サブモジュールも取得済み（`86ad6e56c1700e85f1c5678607a762cfe3aa2f47`）。
picotool の署名・暗号化機能も今回のビルドには不要。

構築時に `make check` が成功。5テストと C/ASM 各1,281サンプルを検証し、
SRAM 配置・命令タイミングは保存済みの `docs/evidence/timing.json` と一致した。
SIO 出力有効化までの理論遅延は C 版80–173.3ns、ASM 版73.3–146.7ns。
これは競合なしの命令モデルであり、実機の pad・配線遅延の測定ではない。

## 日常の操作

リポジトリのルートで実行する。仮想環境の activate は不要。

```sh
make build       # C / ASM 両方を Release -O3 でビルド
make check       # 全テスト、固定音両版ビルド、タイミング解析、各版1,281サンプル検証
make build-midi  # USB MIDI / ASM版
make check-midi  # 全26テスト、3版のバス検証、ASM一致、コア配置・GPIO・MSP起動検証
make info        # 両 UF2 のメタデータを表示
make build-c     # C 版のみ
make build-asm   # ASM 版のみ
make test        # CエンジンをホストコンパイルしてPythonから全26テスト
make timing      # 両版をビルドして build-evidence/ に解析結果を出力
```

生成物は `build-c/famidi.{elf,uf2,bin,dis}` と `build-asm/famidi.{elf,uf2,bin,dis}`。
MIDI版は `build-midi/famidi.{elf,uf2,bin,dis}`。
各 `generated/` に `rom256.bin`、`rom256.h`、`rom.lst`、`famidi.nes` ができる。
生成ファイルは直接編集せず、`src/` または `rom/pulse.s` を変更する。

SDK などを別の場所に置く場合は Make の `PICO_SDK_PATH`、`PICO_TOOLCHAIN_PATH`、
`PYTHON`、`PICOTOOL`、`PICOTOOL_CMAKE_DIR` で上書きできる。
コンパイラを切り替える既存ビルドには、CMake の `--fresh` で再設定が必要。

## Pico 2 への書き込み

NES を OFF にして、Pico 2 の BOOTSEL を押しながら USB 接続する。
ホスト側に現れた USB ドライブへ `build-asm/famidi.uf2` をコピーする。
C 版を使う場合は `build-c/famidi.uf2` をコピーする。
Windows からは WSL のファイルを
`\\wsl.localhost\<ディストリビューション名>\home\owata\famidi\build-asm\famidi.uf2`
で参照できる。

USB デバイスが Linux に公開されている環境では、検証・書き込み・照合・起動まで実行できる。

```sh
make flash-asm
# または make flash-c
```

この作業セッションには USB バスが公開されておらず、デバイスの照会は
`Failed to initialise libUSB` となった。固定音版はユーザー環境で実機動作確認済み。
先行ch1 MIDI版はWindows側からUF2を書き込み、USB列挙・音出しまで実機成功済み。
今回の4音源拡張版はビルド済み、実機の音出しは未確認。
Windows 側での UF2 コピー、またはホスト側で WSL へ USB を接続してから実施する。
電源と配線の条件は [配線](wiring.md) と [最小 PoC](minimal-poc.md) を参照。

## 依存関係を再構築する場合

ホストに CMake、Ninja、Make、Python 3 と venv、GCC/G++、pkg-config、libusb 開発用ファイルが必要。
以下は依存関係をまだ配置していない環境用。

```sh
mkdir -p build-tools
git clone --branch 2.2.0 --depth 1 https://github.com/raspberrypi/pico-sdk.git build-tools/pico-sdk
git -C build-tools/pico-sdk submodule update --init lib/tinyusb
git clone --branch 2.2.0 --depth 1 https://github.com/raspberrypi/picotool.git build-tools/picotool-src

curl -fL -o build-tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi.tar.xz \
  https://developer.arm.com/-/media/Files/downloads/gnu/14.2.rel1/binrel/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi.tar.xz
printf '%s  %s\n' \
  62a63b981fe391a9cbad7ef51b17e49aeaa3e7b0d029b36ca1e9c3b2a9b78823 \
  build-tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi.tar.xz | sha256sum -c -
tar -xJf build-tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi.tar.xz -C build-tools

python3 -m venv build-test-env
build-test-env/bin/python -m pip install -r requirements-test.txt

cmake -S build-tools/picotool-src -B build-tools/picotool-build -G Ninja \
  -DPICO_SDK_PATH="$PWD/build-tools/pico-sdk" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PWD/build-tools/picotool"
cmake --build build-tools/picotool-build -j4
cmake --install build-tools/picotool-build

make check
```
