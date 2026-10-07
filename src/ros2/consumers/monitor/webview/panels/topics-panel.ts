// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file topics-panel.ts
 * 状态页话题区(2026-10-03 十二轮自 ros2_webview_main.ts 拆出):
 * 话题列表(2026-09-26 批次1:弃表格换 flex 行,行尾"订阅"行内动作)——
 * 订阅 = 普通集成终端跑 ros2 topic echo(终端常驻,Ctrl+C 后可改命令重跑);
 * 结果经 commandResult 写回头部反馈小字(见 dom-utils.setActionStatus)。
 */

import { t } from "../shared/i18n";

import { vscode } from "../shared/context";
import { ICON_COPY, ICON_EXEC } from "../shared/icons";
import { attachHoverTip, buildInfoIcon } from "../shared/hover-tip";
import { buildCollapsibleSection, copyCommandToClipboard } from "../shared/dom-utils";

export function renderTopicsList(topics: any[]): void {
    const topicsElement = document.getElementById("topics") as HTMLElement;
    // 十七轮:话题区块可折叠(标题行尾 ▾/▸,状态跨刷新记忆)
    const section = buildCollapsibleSection(
        "topics", t("Topics"),
        buildInfoIcon(t("Real-time topic list; the \"Subscribe\" action at each row starts ros2 topic echo in a regular integrated terminal (system and workspace environment loaded). The terminal is persistent: after Ctrl+C the prompt remains, so you can edit and rerun the command.")),
        "topic-action-status",
    );
    topicsElement.appendChild(section.root);

    const list = document.createElement("div");
    list.className = "entry-list";
    for (const topic of topics) {
        const row = document.createElement("div");
        row.className = "entry-row";
        const name = document.createElement("span");
        name.className = "entry-name";
        name.textContent = topic.name;
        const type = document.createElement("span");
        type.className = "entry-type";
        type.textContent = topic.type;
        const action = document.createElement("span");
        action.className = "param-open-file entry-action";
        action.innerHTML = ICON_EXEC;
        attachHoverTip(action, t("Starts ros2 topic echo in a regular integrated terminal (persistent; edit and rerun)"));
        action.addEventListener("click", () => {
            vscode.postMessage({ command: "subscribeTopic", topic: topic.name });
        });
        const copyTopic = document.createElement("span");
        copyTopic.className = "param-open-file entry-action-copy";
        copyTopic.innerHTML = ICON_COPY;
        attachHoverTip(copyTopic, t("Copy the subscribe command: ros2 topic echo ") + topic.name);
        copyTopic.addEventListener("click", () => {
            copyCommandToClipboard(copyTopic, `ros2 topic echo ${topic.name}`);
        });
        row.appendChild(name);
        row.appendChild(type);
        row.appendChild(copyTopic);
        row.appendChild(action);
        list.appendChild(row);
    }
    if (topics.length === 0) {
        const empty = document.createElement("p");
        empty.className = "param-tree-empty";
        empty.textContent = t("No topics right now");
        section.body.appendChild(empty);
    }
    section.body.appendChild(list);
}
