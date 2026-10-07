# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻参数助手包(2026-10-03 十九轮批4b 自单文件拆出;2026-10-06 彻底推倒重来为信封帧协议):
全局唯一助手服务端 + 多窗口客户端,一切帧复用单条固定路径 Unix socket,一行 JSON 一帧。
上行信封 {client,id,time,request{op}};下行信封 {service,time,cl-num}+response|heartbeat|push。
无握手(accept 即注册),resync=快照经回应返回+结构/详情逐帧补推;参数订阅制(按连接记账);
图一变推全量;生命周期只经权威 push。入口 = assets/ros/param_helper.py(薄启动壳)。
模块地图:kernel(常量/磁盘日志/SIGTERM)/ server(flock 仲裁+连接管理+信封路由+订阅账本+
遥测)/ ros_domain(ROS 句柄与 client 生命周期/熔断/缓存)/ events(图差分全量推+参数事件
账本过滤+生命周期权威推)/ ops_params/forms/lifecycle(业务 op)/ ops(注册表,签名 (req,conn))/
worker(最小负载池+分发+任务看门狗)/ main(组装)。
生命周期:抢锁败者立退;零客户端宽限自退;SIGTERM 立退;任务硬超时自杀。"""
