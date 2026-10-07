# assets/ — 随扩展分发的运行时资源

> 扩展运行时从包内加载的辅助资源(**必须随 vsix 分发**,勿移入 .vscodeignore)。

## 清单

| 文件 | 说明 |
|:--|:--|
| `ros/param_helper.py` | **常驻助手脚本**(rclpy):状态页唯一数据源,由 `src/ros2/consumers/monitor/param-helper-client.ts` 经 stdio JSON-lines 协议启动;Unix Socket 事件/心跳通道;高并发异步(节点哈希路由 4 worker/SIGTERM 处理) |
| `ros/core-monitor/style.css` | 状态页 webview 外部样式(表格/树参考线等全局规则) |

## 注意

- `__pycache__/` 为 Python 运行时缓存,**不入库也不入包**(.gitignore 与 .vscodeignore 均已排除;2026-09-29 已清理本地残留);
- 修改 param_helper.py 协议须同步 `param-helper-client.ts`(请求 id/ping/心跳/截断标记 `__rde_truncated`)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):两文件消费方按 src 引用核对(param-helper-client.ts:7 等) |
