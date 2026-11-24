---
name: dsh-session-error-census
description: 肥鱼报错履历图谱：一条命令扫完本机所有 DSH 会话日志，把「我历史上在哪些动作上反复翻车」按 12 个错误码聚合成表（改文件前没读 / 读完文件被改过 / 替换串对不上 / 网络出口失败 / 沙箱授权写失败 / 安全围栏拦下 / 工具不在表里等），每条带根因、先兆、修法，另附「看着像 bug、其实是设计」的误判案例（别把设计当缺陷修）。用于用户问「最近老报什么错 / 为什么总出错 / 检修一下 / 报错诊断」、准备开始一段长活之前自查姿势、或定位「这个错是不是以前踩过」时。不用于排查单个具体 bug 的现象与复现（那是 diagnosing-bugs），也不用于查当前环境状态是否健康（那是 dsh-health）。
whenToUse: ①用户说「检修 / 自检 / 最近老出错 / 报错诊断 / 看看我电脑上还有什么毛病」；②要开一段长活（大重构、批量改文件、跨多轮任务）之前，先看最近几天哪种姿势在翻车；③撞到一个报错，想知道「这是不是我以前踩过的坑、当时是怎么修的」；④想知道某个错误码出现的先兆，好在出现前停手；⑤想出一份可存档的报错统计报告。不用于：定位一个未知 bug 的根因（用 diagnosing-bugs）、查 bundles/engines/插件契约（用 dsh-health）、审第三方代码（用 third-party-audit）。
---

# dsh-session-error-census：把「我总在哪儿翻车」变成一条命令

一句话：**报错不是随机噪声，是固定姿势的产物。这个技能让我能在 30 秒内看到「最近哪种姿势在翻车、翻了多少次」。**

## 为什么要有它

`dsh-health` 查的是**环境状态**（bundles 悬没悬空、engines 钉没钉版、补丁在不在）。它健康，我也照样会在同样的地方摔：

- 改文件前没 `read` —— 151 次
- 读完之后文件被改过 —— 121 次
- 替换串对不上 —— 57 次

这些不是「环境坏了」，是「我的动作有毛病」。而且它们**不会自愈**：不知道自己在哪反复摔，就会一直摔。

2026-11-24 用户让我把这批履历做成工具，于是有了这个技能。

## 数据从哪来

`~/.dsh/sessions/**/session*.jsonl.zstd` —— 本机所有 DSH 会话日志。

- 规模：一次全量扫描的典型量级——几十到几百个会话文件、数百 MB 解压文本
- 一次全量扫描的示例画像：**703 次报错，12 类**，Top 3 占 61%（数字来自开发者本机，只示范形态；换机后重扫会得到你自己的分布）

### 一个必踩的实现坑

DSH 是追加式写入：**每条记录是一个独立 zstd 帧**拼接。

`zlib.zstdDecompressSync(buf)` 对多帧输入**只解第一帧，而且不抛错**——一个 2.7 MB 文件只解出 244 字节的会话头，扫描器静默返回 0 条。

正确做法：自己按 magic `28 B5 2F FD` 循环定位、逐帧解压。`scripts/scanner.mjs` 已处理，别换回单次解压。

## 怎么跑

```powershell
$node = 'node'   # 或你本机 node 的绝对路径
$scan = "$HOME\.dsh\skills\dsh-session-error-census\scripts\scan.mjs"

# ① 最近 7 天（默认 30 天，最多 120 个文件）
& $node $scan --days 7

# ② 全量（全部会话文件，约 30 秒）
& $node $scan --all

# ③ 查单个错误码的完整档案
& $node $scan --code FS_NOT_OBSERVED

# ④ 出可存档的 Markdown 报告（写 ~/.dsh/error-atlas/诊断-<日期>.md）
& $node $scan --report

# ⑤ 机器可读
& $node $scan --json
```

**注意**：如果你的机器上 `node` 不在 PATH（DSH 自带运行时就是这样），把 `$node` 换成运行时的绝对路径，例如 `$HOME\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。

## 十二个错误码速查

| 错误码 | 历史次数 | 严重度 | 一句话根因 |
|---|---:|---|---|
| `WEB_PROVIDER_ERROR` | 157 | 中 | 网络出口失败（fetch failed 占 119） |
| `FS_NOT_OBSERVED` | 151 | 高 | 改文件前没读 |
| `FS_STALE_VERSION` | 121 | 高 | 读完之后文件被改了 |
| `SAFETY_NET_BLOCKED` | 60 | 中 | 被 cc-safety-net 围栏拦下 |
| `FS_EDIT_NOT_FOUND` | 57 | 高 | 替换串对不上 |
| `FS_NOT_FOUND` | 52 | 中 | 路径不存在 |
| `ACL_WRITE_FAILED` | 51 | 中 | 沙箱授权写失败（= pwsh 整体不可用） |
| `UNKNOWN_TOOL` | 37 | 低 | 工具不在当前工具表 |
| `EPERM` | 8 | 低 | 进程创建被拒 |
| `TIMEOUT` | 4 | 低 | 连接超时 |
| `ECONNRESET` | 3 | 低 | 对端重置 |
| `ENOENT` | 2 | 低 | 文件不存在 |

完整档案（根因 / 先兆 / 修法 / 涉及工具 / 典型原文）在 `references/knowledge.json`，用 `--code` 查。

## 怎么读结果（三条判据）

1. **看 Top 3 的占比，不看绝对数。** Top 3 超过 50% = 姿势问题，不是运气问题；这时候改动作比修单个 bug 收益大得多。
2. **区分「环境事实」与「操作失误」。** 脚本会单列 `envFact` 的码。例如 `ACL_WRITE_FAILED`（`SetNamedSecurityInfoW failed (Win32 5)`）一出现，`pwsh` 整个工具就不可用——那不是我做错了，是环境坏了，应该换 `read`/`write`/`grep` 绕过去，而不是反复重试同一个命令。
3. **看「紧跟什么之后」。** `FS_STALE_VERSION` 有 44 次紧跟在 `build_*.py` 之后——跑完构建脚本重生成、回头再 edit 源文件，版本必然对不上。这类是**流程缺陷**，应该在流程里改（先改源再构建，或构建后重新 read）。

## 误判清单：看着像 bug，其实是设计

不是所有「不对劲」都是缺陷。这一类先查清是不是设计行为，再决定修不修——**把设计当 bug 修，比不修更糟**。

当前收录 1 条（`references/knowledge.json` 的 `misdiagnoses`，每条含 `symptom / looksLike / actually / evidence / howToTell / dontDo / doInstead`）：

### `chat-scroll-jump`：切会话自己往上滑

- **症状**：点会话切换进去，界面自己向上滑一段，要手动滑回底部。用户原话 2026-11-24：「点进去之后，会莫名其妙向上滑动一段，要自己手动滑下来」。
- **像什么**：渲染完又重排 / 虚拟列表重算高度导致的滚动跳动，典型前端 bug。
- **其实是什么**：DSH 按会话记住阅读位置。`use-chat-reading.ts` 的 `restore()`：`store.read()` 为 `null` 才 `followTail()` 落到底，否则 `viewport.restore(saved)` 回到上次停的那条消息；调用点是 `use-chat-scroll.ts` 里「会话由关变开」那一支。
- **怎么分辨**：①只有「上次翻到中间就离开」的会话这样，一直在底部的不会；②停的位置总是同一条消息，不随机；③切进去不动它，不会再往下漂。
- **别做什么**：别去改滚动容器 / `toBottom` / 虚拟列表高度，也别当 CSS 或 ResizeObserver 问题。
- **真要做**：要每次都落底就清掉该会话的 `chatScroll` 记录（或写客户端插件），代价是丢掉「接着看」。

**通用判据**（比这一条本身有用）：用户报「是不是 bug」时，先给出「这是设计 / 这是缺陷 / 无法判定」三档结论和证据，再谈改不改。真的缺陷另有特征——**同一状态下重复同样操作，结果不稳定**；设计行为则稳定可复现且能对应到源码里的一个明确分支。

## 知识库怎么更新

`references/knowledge.json` 是手工维护的：每次扫到一个**知识库里没有的新形态**，把它的根因、先兆、修法补进去，同时在 `codes` 里加一条、`totalHits` 不变（那是历史基数）。

判据：如果同一个错误码第三次以「知识库没写的新原因」出现，说明该补条目了，而不是继续临时救火。

## 局限（写在这里，不藏在报告里）

1. **只覆盖落盘到日志的错误。** 调用前被拦、崩溃前没写盘的，扫不到。
2. **新形态的错误会落到「未识别」。** 不会自动进知识库，得人工补。
3. **历史频次是 2026-11-24 一次性全量扫描的画像**，代表「过去」，不代表「当前环境状态」。当前环境健康与否看 `dsh-health`。
4. **`classify()` 是文本特征匹配**，同一条错误可能被更早的规则抢走（实测修过一次：`not found` 曾被漏归类到 `FS_NOT_FOUND`）。改规则后必须重跑 `tests\selftest.mjs`。

## 自检

```powershell
& $node "$HOME\.dsh\skills\dsh-session-error-census\tests\selftest.mjs"
```

24 项断言：知识库完整性（含误判清单的结构与证据完整性）、12 种样本归类、真实日志扫描、报告可写。当前 **24 passed, 0 failed**。

## 为什么是技能，不是插件

目录放进 `~/.dsh/skills/` 即生效，下一轮就能被 `skill` 工具加载——不需要 pnpm、不需要改 profile、不需要重启宿主。插件形态（注册成工具）在作者本机另有实现，但仓库只发布技能形态：它本来就是「干活前先看一眼」的东西，不值得为它常驻一个 bundle。
