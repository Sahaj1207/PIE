#!/usr/bin/env bash
# Verifies that the native background-reconstruction ports produce byte-identical output to the
# unit-tested TypeScript reference (src/features/image/textInpainting.ts):
#   Android  android/app/src/main/java/com/com.pdfimageeditor/image/TextInpainting.kt  (run on the JVM)
#   iOS      ios/PieNative/PieTextInpainting.h                                         (run as WebAssembly)
# No device, emulator or Mac needed. Requirements (paths can be overridden):
#   JAVA        a Java 17+ runtime (default: Android Studio's bundled JBR)
#   GRADLE_HOME Gradle user home holding the Kotlin compiler jars (default: D:/.gradle or ~/.gradle)
#   NDK         Android NDK root (clang with the wasm32 target + wasm-ld)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/inpainting-parity"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

JAVA="${JAVA:-/c/Program Files/Android/Android Studio/jbr/bin/java.exe}"
GRADLE_HOME="${GRADLE_HOME:-$( [ -d /d/.gradle ] && echo /d/.gradle || echo "$HOME/.gradle")}"
NDK="${NDK:-$HOME/AppData/Local/Android/Sdk/ndk/27.1.12297006}"
C="$GRADLE_HOME/caches/modules-2/files-2.1"
SEP=":"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";" ;; esac

# Paths handed to Java / node / clang (Windows tools need Windows paths)
np() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
jar() {
  local f
  f="$(find "$C/$1" -name "$2" | grep -v sources | sort | head -1)"
  [ -n "$f" ] || { echo "missing $2 in $C/$1" >&2; exit 1; }
  np "$f"
}

KCP="$(jar org.jetbrains.kotlin/kotlin-compiler-embeddable 'kotlin-compiler-embeddable-2.*.jar')"
KCP="$KCP$SEP$(jar org.jetbrains.kotlin/kotlin-stdlib 'kotlin-stdlib-2.*.jar')"
KCP="$KCP$SEP$(jar org.jetbrains.kotlin/kotlin-script-runtime 'kotlin-script-runtime-*.jar')"
KCP="$KCP$SEP$(jar org.jetbrains.kotlin/kotlin-reflect 'kotlin-reflect-*.jar')"
KCP="$KCP$SEP$(jar org.jetbrains.kotlin/kotlin-daemon-embeddable 'kotlin-daemon-embeddable-*.jar')"
KCP="$KCP$SEP$(jar org.jetbrains.intellij.deps/trove4j 'trove4j-*.jar')"
KCP="$KCP$SEP$(jar org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm 'kotlinx-coroutines-core-jvm-*.jar')"
KCP="$KCP$SEP$(jar org.jetbrains/annotations 'annotations-*.jar')"
STD="$(jar org.jetbrains.kotlin/kotlin-stdlib 'kotlin-stdlib-2.*.jar')"

echo "1/3 TypeScript reference"
(cd "$ROOT" && PARITY_OUT="$(np "$OUT/ts.txt")" node node_modules/jest/bin/jest.js __tests__/textInpainting.test.ts -t "golden output" >/dev/null 2>&1)

echo "2/3 Kotlin (JVM)"
mkdir -p "$OUT/kt"
"$JAVA" -cp "$KCP" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-reflect -cp "$STD" -d "$(np "$OUT/kt")" \
  "$(np "$ROOT/android/app/src/main/java/com/com.pdfimageeditor/image/TextInpainting.kt")" \
  "$(np "$HERE/Harness.kt")" 2>&1 | grep -iv "kotlin home" || true
"$JAVA" -cp "$(np "$OUT/kt")$SEP$STD" HarnessKt > "$OUT/kt.txt"

echo "3/3 C (WebAssembly)"
CLANG="$(find "$NDK/toolchains/llvm/prebuilt" -maxdepth 3 \( -name clang -o -name clang.exe \) | head -1)"
"$CLANG" --target=wasm32 -std=c99 -O2 -Wall -Wextra -Werror -ffreestanding -nostdlib -Wl,--no-entry \
  -Wl,--export=run -Wl,--export=patchPtr -Wl,--export=resultPtr \
  -o "$(np "$OUT/inp.wasm")" "$(np "$HERE/harness.c")"
node "$(np "$HERE/run-wasm.js")" "$(np "$OUT/inp.wasm")" "$(np "$OUT/c.txt")"

status=0
for impl in kt c; do
  if cmp -s "$OUT/ts.txt" "$OUT/$impl.txt"; then
    echo "  $impl: identical to the TypeScript reference"
  else
    echo "  $impl: DIFFERS from the TypeScript reference"
    status=1
  fi
done
exit $status
