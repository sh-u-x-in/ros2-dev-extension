/**
 * @file helper-state.ts
 * 常驻助手在线状态唯一事实源(consumers/ 内部,组件间变量互通)。
 * 2026-10-06 重设计语义:在线 = 已连接共享助手服务端(hello 握手完成)。
 *   - 写路径:param-helper-client 的连接生命周期(hello_ack 到达=在线;连接断开=离线),事件驱动无轮询;
 *   - 读路径:订阅 onHelperRunningChanged(状态栏订阅翻转显示)/轮询读。
 * 纯内部模块,不建 api 契约;无 vscode 依赖,可单测。
 */

/** 当前助手在线状态(默认 false:未连接视为不在线) */
let helperRunning = false;

/** 订阅者(状态变化广播;无 vscode EventEmitter 依赖,纯函数式) */
type Listener = (running: boolean) => void;
const listeners: Listener[] = [];

/** 写:设置当前助手在线状态(仅 param-helper-client 连接生命周期调用;值变化才广播) */
export function setHelperRunning(v: boolean): void {
    if (v !== helperRunning) {
        helperRunning = v;
        for (const l of listeners) {
            try { l(v); } catch { /* 订阅者异常不影响广播 */ }
        }
    }
}

/** 读:当前助手在线状态(状态页投影 ready 语义用;同步零依赖) */
export function getHelperRunning(): boolean {
    return helperRunning;
}

/** 订阅:助手在线状态变化通知(状态栏订阅翻转显示;返回退订函数) */
export function onHelperRunningChanged(listener: Listener): () => void {
    listeners.push(listener);
    return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) { listeners.splice(i, 1); }
    };
}
