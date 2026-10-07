#!/usr/bin/env bash
# 名单一致性核对:build-only 跳转表(我们) vs install 侧真实可执行(地面真相)
#   用法(VM 上):bash /home/ros2/rde-ros-2/test/run-install-parity.sh [工作区根]
#
# 地面真相口径 = 复刻 ros2pkg 官方算法(与扩展 install-build 手册一致):
#   前缀 lib/<pkg>/ 的直接子文件,判据 X_OK;并按符号链接手册坑#6 放宽:
#   软链目标含 shebang 的文本也算候选(规避 install(PROGRAMS) 源无 +x 被静默过滤)。
#   排除 .so(库不是"可执行跳转"目标)与嵌套目录(python3.x/cmake 等不是包前缀)。
set -o pipefail

WS=${1:-/home/ros2/roa2_ws}
REPO=/home/ros2/rde-ros-2

cd "$REPO" || exit 1
node test/run-buildmap-live.js "$WS" --names > /tmp/buildmap-ours.txt || exit 1

cd "$WS" || exit 1
: > /tmp/buildmap-installed.txt
for libdir in install/lib install/*/lib; do
    [ -d "$libdir" ] || continue
    for pkgdir in "$libdir"/*/; do
        [ -d "$pkgdir" ] || continue
        pkg=$(basename "$pkgdir")
        case "$pkg" in
            python3.*|cmake|pkgconfig|python) continue ;;
        esac
        for f in "$pkgdir"*; do
            [ -f "$f" ] || [ -L "$f" ] || continue
            case "$(basename "$f")" in
                *.so|*.so.*|*.a|*.pyc) continue ;;
            esac
            if [ -x "$f" ]; then
                echo "$pkg/$(basename "$f")" >> /tmp/buildmap-installed.txt
            elif [ -L "$f" ] && head -c 2 "$f" 2>/dev/null | grep -q '#!'; then
                echo "$pkg/$(basename "$f")" >> /tmp/buildmap-installed.txt
            fi
        done
    done
done
sort -u -o /tmp/buildmap-installed.txt /tmp/buildmap-installed.txt

echo "== build-only 名单($(wc -l < /tmp/buildmap-ours.txt) 条)=="
cat /tmp/buildmap-ours.txt
echo
echo "== install 侧真实可执行($(wc -l < /tmp/buildmap-installed.txt) 条,ros2pkg 口径)=="
cat /tmp/buildmap-installed.txt
echo
echo "== diff(ours vs installed)=="
if diff /tmp/buildmap-ours.txt /tmp/buildmap-installed.txt; then
    echo "NO_DIFF:名单完全一致"
else
    echo "DIFF:见上(< 仅我们有 / > 仅 install 有)"
fi
