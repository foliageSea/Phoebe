# 菲比语音播报 / Phoebe voice announcements

为 DSH Desktop 的主会话加上菲比的中文语音提醒：Agent 发起结构化询问时播报，正常结束一轮时播报最终答复。声音从运行 DSH Host 的电脑默认音频设备发出，可能是扬声器或耳机；浏览器不用开音频权限，切走对话页仍可能听到。配置范围内的多个主会话共用一个播放器，同类待播提醒可能被更新的提醒替换。插件不修改文字回复，不代答，不播历史、子 Agent、工具进度、权限弹窗或中断的答复。计划评审只读固定提醒。

## 安装与启用

- **macOS**：可用 Homebrew 安装 `ffmpeg`，插件会检查常用安装目录中的 `ffplay`。
- **Windows**：请在能运行 DSH Desktop 的 Windows 主机上安装包含 `ffplay.exe` 的 FFmpeg 发行版。将其 `bin` 目录加入 `PATH` 后，完全退出并重新打开 DSH Desktop；也可以在插件配置中把 `playerPath` 设为 `ffplay.exe` 的完整路径，例如 `C:\ffmpeg\bin\ffplay.exe`。仅在 Windows 浏览器打开远程 DSH 时，声音仍从远程 Host 播放。

1. 此 bundle 的最低 DSH Desktop 版本为 **`0.2.2-rc.5`**；更新版本可通过版本检查，但未逐一验证。在 DSH 中打开 **插件 → 添加插件**，粘贴 [GitHub Releases](https://github.com/foliageSea/Phoebe/releases) 中 `.tgz` 安装包的下载链接，点击 **安装 → 立即启用**。从源码安装时，也可以填写插件目录的绝对路径。若装过旧的本地开发版，请先停用并卸载旧版，再安装 `@foliagesea/dsh-phoebe-voice`；安装后重新确认播报模式和工作区范围，不要假设旧设置会自动迁移。插件显示已启用时，`mode: off` 仍会保持静音。
2. 在 [Fish Audio 开发者页面](https://fish.audio/app/developers/get-started/)取得 API Key（默认菲比音色的固定提醒不需要 Key，可跳过）。打开 **插件 → 菲比语音播报**，在「包含的组件」里点击带右箭头的 **菲比语音播报** 行名称。在 **Fish Audio 凭据**中填写 Key 并点击 **保存密钥**。密钥通过 DSH 凭据服务保存为 `FISH_API_KEY`；如果以前已经配置过，页面会显示「已配置密钥」，无需重填。页面不会回显已保存的 Key，也不会在保存时调用 Fish 验证。不要把 Key 发到聊天里。
3. 在 **语音播报**中修改 `reference_id`（默认是原来的菲比音色），可点击 **使用默认菲比音色**恢复。默认菲比音色已随包附带三条固定 MP3，选择 **仅固定提醒** 即可离线播放，无需手动生成。若换用其他音色，保存后在 **固定音频预设** 中为该音色生成，可明确选择免费或付费模型；这不改变摘句的模型。如果希望朗读问题和最终答复的摘句，选择 **朗读简短摘句**；这一模式会把摘句发送到 Fish Audio。
4. 在任意 DSH 工作区新建主会话。输入「请用 `ask_user_question` 问我更喜欢蓝色还是绿色；收到回答后告诉我选了什么」，看到问题卡片后先等语音，再回答。首次试用用非敏感文本。如果没声音，确认插件已启用、播报模式不是「关闭」、会话目录在范围内、固定音频已生成或摘句的 Key 可用、`ffplay` 已安装，并在系统声音设置中检查默认输出设备。静音时把播报模式设为「关闭」并保存，或关掉此 bundle。

## 菲比 AI 简述

在 **插件 → 菲比语音播报 → 语音播报** 选择 **菲比 AI 简述** 并保存。默认不开启，需要和摘句模式一样配置 Fish Audio Key。

- 仅对正常完成的主会话最终答复调用一次 DSH 模型，复用本轮回复的模型，不启动额外 Agent、不调用工具，也不发送聊天历史。结构化提问仍按摘句模式播报，计划评审仍播固定提醒。
- 模型把要点写成一两句温柔自然的中文，保留结果、失败和未确认的事项。模型不可用、6 秒内无结果或输出不合格时，退回本地规则摘句；无可用摘句时播固定提醒。
- 插件先在本机过滤最终答复，再把最多 3,000 个字符发给本轮 DSH 模型；模型提供方可能计费。Fish Audio 只收到最终播报稿。过滤不能保证识别所有敏感内容，敏感会话请用 **仅固定提醒** 或 **关闭**。

## 聊天快捷切换与余额

聊天输入框下方可切换 **静音 / 固定 / 摘句 / AI 简述**。选择 AI 简述时会弹出确认窗口，说明文本发往哪里。点击 **开启 AI 简述** 后才保存；点 **取消** 或按 Esc 保持原模式。其他模式直接保存。这里改的是插件的播报模式，不只影响当前会话。配置 `FISH_API_KEY` 后，同一区域会显示 Fish Audio 付费 API 余额，不显示免费额度。点击余额可刷新；聊天页可见时每两分钟自动查询，服务端最多缓存 15 秒。即使播报模式为「关闭」，余额查询仍可使用。查询由 DSH Host 发起，密钥不会发送到浏览器。

## 配置

| 字段 | 说明 |
| --- | --- |
| `mode` | `off`（默认，静音）；`notice`（只播放已生成的本地固定音频）；`brief`（发送固定开场和简短摘句，无合适摘句时退回本地固定提醒）；`summary`（用本轮 DSH 模型生成菲比风格的最终回复简述）。固定音频不存在时跳过该条播报，不回退到联网合成。 |
| `workspaceRoot` | 默认 `/` 表示所有 DSH 工作区（Windows 上包含所有盘符）。也可设为已有目录的完整路径（例如 `D:\Projects`），只播报该目录及其子目录中的主会话。更新插件不会覆盖已有的范围设置。 |
| `reference_id` | Fish Audio 音色 ID；默认 `8e80c3dcdf894213a10b48e9b08ad8c6`（[菲比](https://fish.audio/m/8e80c3dcdf894213a10b48e9b08ad8c6/)）。在页面保存后，下次播报使用。 |
| `fishModel` | Fish 发音引擎，默认 `s2.1-pro-free`；可选付费的 `s2.1-pro`。与参考音色 ID 是不同设置。 |
| `playerPath` | 可选。`ffplay` 或 `ffplay.exe` 的完整路径。未指定时，Windows 按 Host 的 `PATH` 顺序检查绝对目录中的 `ffplay.exe`；其他平台检查 `/opt/homebrew/bin/ffplay`、`/usr/local/bin/ffplay`、`/usr/bin/ffplay`。 |

`brief` 在本机从问题正文或最终答复中摘取原句，最多 120 字符，不调用额外的 LLM。它会跳过常见代码、命令和疑似敏感内容，但**无法保证识别所有隐私或凭据**；敏感会话用 `notice` 或 `off`。问题刚回答或取消、会话切走工作目录、关闭插件时，相关播放会停止。问题提醒可打断结果播报。Fish 不可用时不会阻止 Agent 正常工作；Host 日志中 `[phoebe-voice]` 后的简短错误码可用于诊断：`missing-key`、`missing-player`、`http-401`、`http-402`、`http-429` 等。插件不会把实时摘句或简述写盘，也不会自动重试。默认三条菲比音频随包附带；自定义音色预设存放在 DSH Home 的 `cache/phoebe-voice`，按音色、模型和台词区分。已成功生成的片段不会重复请求。

## 开发与参考

根目录保留 DSH 的宿主和 Web 客户端入口；宿主端的会话钩子、播报、预设与余额查询实现位于 `host/`。内置音频、翻译和测试分别位于 `audio/`、`locale/`、`test/`。

使用 Node.js 22+ 运行 `npm ci --ignore-scripts`、`npm test`。DSH 的 `user-questions/request` 与 `session/event` 负责触发，Fish [HTTP 音频流](https://docs.fish.audio/features/realtime-streaming.md)按块输入 `ffplay`。台词为原创中文短句，参考[库街区图鉴入口](https://wiki.kurobbs.com/mc/item/1309523456688947200)和[菲比角色条目](https://wuthering.wiki/character_1506.html)。
