// [diag] 心跳到达性探针:真实编译产物 + 真实 socket,直连当前活着的助手,量 15s 心跳/推送
const { installVscodeStub } = require('../../out/test/suite/_vscode-stub.js');
installVscodeStub();
const client = require('../../out/src/ros2/consumers/monitor/helper/param-helper-client.js');
client.setParamHelperEnvFacade({
    getEnv: () => ({ ROS_VERSION: "2", ROS_DISTRO: "humble", ROS_DOMAIN_ID: "0", RMW_IMPLEMENTATION: "0" }),
    getEnvIssue: () => null,
});
let hb = 0, first = null;
const pushes = [];
client.setHelperPushCallback(f => pushes.push(f.kind));
client.onHelperHeartbeat(s => { hb += 1; if (!first) first = s; });
const gen = client.startParamHelper("/tmp/no-such-helper.py");
console.log("PROBE gen=", gen);
setTimeout(() => {
    console.log("RESULT heartbeats=", hb);
    console.log("RESULT first=", JSON.stringify(first));
    console.log("RESULT pushes=", JSON.stringify(pushes));
    console.log("RESULT state=", client.describeHelperState());
    client.stopParamHelper();
    process.exit(0);
}, 15000);
