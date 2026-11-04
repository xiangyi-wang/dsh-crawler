#!/bin/bash
# 真正的构建入口：引擎/形态/音色内联进 lib/client.js（见 scripts/build-client.cjs）。
#
# 历史上这里是 dev_scaffold_plugin 生成的 tsc 流程（src/*.ts → lib/），
# 但本插件的 host 半边是手写的 lib/index.js、client 半边是 src/client/index.js
# 经 build-client.cjs 打包，走 tsc 会覆盖 lib/index.js。现在只保留这一条。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node scripts/build-client.cjs
