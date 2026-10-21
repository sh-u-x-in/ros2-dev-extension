// Copyright (c) Microsoft Corporation. All rights reserved.

/** 助手进程版本治理(2026-10-20;规范=同目录 VERSION-CONTROL.md,冻结文件):
 *  锁文件第 4 字段=拉起该服务端的扩展版本(TS 经 spawn argv `--ext-version` 传入,
 *  缺省/占位 "0")。客户端在「无自有进程、要去连现成服务端」时读锁比对裁定:
 *  锁比我旧 / 锁不可解析(含 0.0.3- 遗留的三字段锁、占位 "0")→ 杀旧拉新;
 *  锁比我新 → 让位共享;相等 → 共享;我方版本不可解析 → 治理禁用(绝不杀,防自伤)。
 *  单向淘汰(只杀严格更旧)保证多客户端跨版本共存无杀拉震荡:
 *  旧客户端连上新服务端只会共享(其后 socket 断开也只重连共享,不再 spawn)。 */

/** 严格 semver 三段数值解析(纯十进制整数,拒前导噪声);不可解析=null */
export function parseExtensionVersion(v: string | undefined): [number, number, number] | null {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec((v ?? "").trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 客户端裁定:是否应替换(杀旧拉新)现有服务端。
 *  @param lockVersion 锁文件第 4 字段(undefined=三字段旧格式锁或字段缺失)
 *  @param myVersion   本扩展版本(undefined/不可解析=治理禁用,恒 false) */
export function shouldReplaceServer(lockVersion: string | undefined, myVersion: string | undefined): boolean {
    const mine = parseExtensionVersion(myVersion);
    if (!mine) {
        return false;
    }
    const lock = parseExtensionVersion(lockVersion);
    if (!lock) {
        return true;   // 锁侧未知(旧格式/占位 "0")=视为最旧
    }
    for (let i = 0; i < 3; i++) {
        if (lock[i] !== mine[i]) {
            return lock[i] < mine[i];
        }
    }
    return false;   // 相等 → 共享
}
