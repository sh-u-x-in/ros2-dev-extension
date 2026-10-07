#!/usr/bin/env bash
# 四象限矩阵:iso/merged × entity/symlink 各**重新构建一遍**,
# 对同一份 build-only 跳转表取 digest,要求四者**逐字节相同**。
#
# 立论:本模块只吃 build/,不涉及构建类型与安装方式 → 四象限必须同解。
# 用法(在 VM 上,roa2_ws 只存在于 VM 本地盘):
#   ssh ros2-vm 'bash /home/ros2/rde-ros-2/test/run-quadrant-matrix.sh'
#
# 说明:脚本会 rm -rf build/install/log 后重建,**最后停在"恢复象限"**
#   - 默认 = 运行前检测到的象限;
#   - 可显式指定:FINAL_QUADRANT=merged-symlink bash test/run-quadrant-matrix.sh
# 注意:**不要 `set -u`** —— ROS 的 setup.bash 会引用未绑定变量,开了 nounset 直接失败。
set -o pipefail

WS=/home/ros2/roa2_ws
REPO=/home/ros2/rde-ros-2
OUT=$REPO/discover/.compare
mkdir -p "$OUT"

ROS_SETUP=/opt/ros/humble/setup.bash

# ---------- 检测当前象限 ----------
detect() {
    local layout=mode
    if [ -d "$WS/install/lib" ] && [ -d "$WS/install/share" ]; then
        layout=merged
    elif [ -d "$WS/install/lll" ]; then
        layout=isolated
    else
        layout=unknown
    fi
    if [ -n "$(find "$WS/install" -maxdepth 6 -type l 2>/dev/null | head -1)" ]; then
        mode=symlink
    else
        mode=entity
    fi
    echo "$layout-$mode"
}

# ---------- 单象限:清理 → 构建 → digest ----------
run_quad() {
    local name=$1
    shift
    echo "============================================================"
    echo "[$name] clean build/install/log"
    rm -rf "$WS/build" "$WS/install" "$WS/log"
    echo "[$name] colcon build $*"
    (
        cd "$WS" || exit 1
        # shellcheck disable=SC1090
        source "$ROS_SETUP"
        colcon build --cmake-args -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_EXPORT_COMPILE_COMMANDS=ON "$@"
    ) > "/tmp/colcon-$name.log" 2>&1
    local rc=$?
    echo "[$name] colcon rc=$rc  (log: /tmp/colcon-$name.log)"
    if [ $rc -ne 0 ]; then
        tail -25 "/tmp/colcon-$name.log"
        echo "[$name] BUILD-FAILED"
        return $rc
    fi
    ( cd "$REPO" && node test/run-buildmap-live.js "$WS" --digest > "$OUT/buildmap-$name.json" 2>"/tmp/digest-$name.err" )
    if [ ! -s "$OUT/buildmap-$name.json" ]; then
        echo "[$name] DIGEST-EMPTY"; cat "/tmp/digest-$name.err"; return 1
    fi
    local entries
    entries=$(grep -c '^      "' "$OUT/buildmap-$name.json" 2>/dev/null || true)
    echo "[$name] detected=$(detect)"
    echo "[$name] digest sha256=$(sha256sum "$OUT/buildmap-$name.json" | cut -c1-24)"

    # 名单对拍:build-only 名单 vs install 侧真实可执行(ros2pkg 口径) —— 每象限各做一次
    ( cd "$REPO" && bash test/run-install-parity.sh "$WS" > "/tmp/parity-$name.txt" 2>&1 )
    if grep -q NO_DIFF "/tmp/parity-$name.txt"; then
        echo "[$name] parity: NO_DIFF(名单与 install 侧完全一致)"
    else
        echo "[$name] parity: DIFF(见 /tmp/parity-$name.txt)"
        sed -n '/== diff/,$p' "/tmp/parity-$name.txt" | head -12
    fi
    return 0
}

# ---------- 顺序:恢复象限放最后(结束时回到用户原本的状态) ----------
INIT=$(detect)
FINAL=${FINAL_QUADRANT:-$INIT}
case "$FINAL" in unknown-*) FINAL="" ;; esac
echo "initial-quadrant=$INIT  final-quadrant=${FINAL:-<none>}"
ALL="iso-entity iso-symlink merged-entity merged-symlink"
ORDER=""
for q in $ALL; do
    if [ "$q" != "$FINAL" ]; then ORDER="$ORDER $q"; fi
done
if [ -n "$FINAL" ]; then ORDER="$ORDER $FINAL"; else ORDER="$ALL"; fi

FAILED=""
for q in $ORDER; do
    case "$q" in
        iso-entity)    run_quad "$q" || FAILED="$FAILED $q" ;;
        iso-symlink)   run_quad "$q" --symlink-install || FAILED="$FAILED $q" ;;
        merged-entity) run_quad "$q" --merge-install || FAILED="$FAILED $q" ;;
        merged-symlink) run_quad "$q" --merge-install --symlink-install || FAILED="$FAILED $q" ;;
    esac
done

# ---------- 比较 ----------
echo "============================================================"
echo "== 四象限 digest 比较 =="
if [ -n "$FAILED" ]; then
    echo "构建失败象限:$FAILED(比较不完整)"
fi
BASE=""
for q in $ALL; do
    f="$OUT/buildmap-$q.json"
    if [ ! -s "$f" ]; then
        echo "  $q : MISSING"
        continue
    fi
    if [ -z "$BASE" ]; then
        BASE="$f"
        echo "  $q : BASELINE ($(sha256sum "$f" | cut -c1-16))"
        continue
    fi
    if diff -q "$BASE" "$f" > /dev/null 2>&1; then
        echo "  $q : SAME (与基线逐字节相同)"
    else
        echo "  $q : DIFF(与基线不同,差异前 40 行)"
        diff "$BASE" "$f" | head -40
    fi
done
echo
echo "最终象限=$(detect)  产物目录=$OUT"
