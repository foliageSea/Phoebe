# 菲比语音播报 / Phoebe voice announcements

为 DSH Desktop 的主会话加上菲比的中文语音提醒：Agent 发起结构化询问时播报，正常结束一轮时播报最终答复。声音从运行 DSH 的 Mac 默认音频设备发出，可能是扬声器或耳机；浏览器不用开音频权限，切走对话页仍可能听到。配置范围内的多个主会话共用一个播放器，同类待播提醒可能被更新的提醒替换。插件不修改文字回复，不代答，不播历史、子 Agent、工具进度、权限弹窗或中断的答复。计划评审只读固定提醒。

## 安装与启用

1. 此 bundle 针对 **DSH Desktop `0.2.2-rc.5`**。在 DSH 中打开 **插件 → 添加插件**，输入本地目录 `/Users/foliage/Desktop/Phoebe`，点击 **安装 → 立即启用**。若已经看到「菲比语音播报」，不要重复安装；确认组合包及其插件行均开启。插件显示已启用时，`mode: off` 仍会保持静音。
2. 在 [Fish Audio 开发者页面](https://fish.audio/app/developers/get-started/)取得 API Key。打开 **插件 → 菲比语音播报**，在「包含的组件」里点击带右箭头的 **菲比语音播报** 行名称。在 **Fish Audio 凭据**中填写 Key 并点击 **保存密钥**。密钥通过 DSH 凭据服务保存为 `FISH_API_KEY`；如果以前已经配置过，页面会显示「已配置密钥」，无需重填。页面不会回显已保存的 Key，也不会在保存时调用 Fish 验证。不要把 Key 发到聊天里。
3. 在 **语音播报**中修改 `reference_id`（默认是原来的菲比音色），可点击 **使用默认菲比音色**恢复。先选 **仅固定提醒**并点击 **保存播报设置**。如果希望朗读问题和最终答复的摘句，再选 **朗读简短摘句**；这一模式会把摘句发送到 Fish Audio。
4. 在 `/Users/foliage/Desktop/Phoebe` 范围内新建 DSH 会话。输入「请用 `ask_user_question` 问我更喜欢蓝色还是绿色；收到回答后告诉我选了什么」，看到问题卡片后先等语音，再回答。首次试用用非敏感文本。如果没声音，确认插件已启用、播报模式不是「关闭」、会话目录在范围内、Key 与 `ffplay` 可用，并在 Mac **系统设置 → 声音 → 输出**检查目标设备。静音时把播报模式设为「关闭」并保存，或关掉此 bundle。

## 配置

| 字段 | 说明 |
| --- | --- |
| `mode` | `off`（默认，完全静音、无 Fish 请求）；`notice`（只将固定中文台词发送给 Fish）；`brief`（发送固定开场和简短摘句，无合适摘句时退回固定提醒）。 |
| `workspaceRoot` | 启用时必填的绝对路径；包含工作目录位于此处或子目录中的主会话。处在范围外的符号链接不纳入。 |
| `reference_id` | Fish Audio 音色 ID；默认 `8e80c3dcdf894213a10b48e9b08ad8c6`（[菲比](https://fish.audio/m/8e80c3dcdf894213a10b48e9b08ad8c6/)）。在页面保存后，下次播报使用。 |
| `fishModel` | Fish 发音引擎，默认 `s2.1-pro-free`；可选付费的 `s2.1-pro`。与参考音色 ID 是不同设置。 |
| `playerPath` | 可选。`ffplay` 的绝对路径；未指定时检查 `/opt/homebrew/bin/ffplay`、`/usr/local/bin/ffplay`、`/usr/bin/ffplay`。 |

`brief` 在本机从问题正文或最终答复中摘取原句，最多 120 字符，不调用额外的 LLM。它会跳过常见代码、命令和疑似敏感内容，但**无法保证识别所有隐私或凭据**；敏感会话用 `notice` 或 `off`。问题刚回答或取消、会话切走工作目录、关闭插件时，相关播放会停止。问题提醒可打断结果播报。Fish 不可用时不会阻止 Agent 正常工作；Host 日志中 `[phoebe-voice]` 后的简短错误码可用于诊断：`missing-key`、`missing-player`、`http-401`、`http-402`、`http-429` 等。网络失败不会自动重试，也不会创建音频文件。

## 开发与参考

使用 Node.js 22+ 运行 `npm ci --ignore-scripts`、`npm test`。DSH 的 `user-questions/request` 与 `session/event` 负责触发，Fish [HTTP 音频流](https://docs.fish.audio/features/realtime-streaming.md)按块输入 `ffplay`。台词为原创中文短句，参考[库街区图鉴入口](https://wiki.kurobbs.com/mc/item/1309523456688947200)和[菲比角色条目](https://wuthering.wiki/character_1506.html)。
