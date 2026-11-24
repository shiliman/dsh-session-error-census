# dsh-session-error-census

> 把「我总在哪儿翻车」变成一条命令。

一个 DeepSeek Harness（DSH）技能：扫一遍本机所有会话日志，把历史报错按错误码聚合成一张表，每条带**根因、先兆、修法**；另附一份「看着像 bug、其实是设计」的误判清单。

```
$ node scan.mjs --days 7

扫描 36 个会话文件（最近 7 天，3.7 s），命中 78 次报错。

错误码                次数    占比     严重度   一句话
--------------------------------------------------------------------------------
FS_NOT_OBSERVED       20      25.6%    高       改文件前没读
ENOENT                12      15.4%    低       文件不存在
UNKNOWN_TOOL          10      12.8%    低       工具不在当前工具表
EPERM                 9       11.5%    低       进程创建被拒
WEB_PROVIDER_ERROR    9       11.5%    中       网络出口失败

Top 3 合计 42 次，占 53.8%。

最该先处理：FS_NOT_OBSERVED ×20（25.6%）
  改文件前没有先读一遍，平台拒绝写入。
  → 动任何既有文件之前，先 read 一次。
```

---

## 装法

把整个目录丢进 DSH 技能目录即可（宿主自动发现，无需 pnpm / 重启）：

```
~/.dsh/skills/dsh-session-error-census/
```

仓库里的文件是**平铺**的（scan.mjs 与 knowledge.json 同级），脚本里做了两种布局的自动探测；如果你按 scripts/ + eferences/ + 	ests/ 分开放，也一样能跑。

## 为什么需要它

DSH 已经有一个 `dsh-health` 查**环境状态**：bundles 有没有悬空、版本闸门有没有钉死、本地补丁还在不在。

但环境全绿，我照样会在同样的地方摔：

- 改文件前不 `read` —— 撞了 151 次
- 读完的文件被别的步骤改过 —— 121 次
- `old_string` 对不上 —— 57 次

这些不是「环境坏了」，是**动作有毛病**。而且它们不会自愈：不知道自己反复摔在哪儿，就会一直摔。

所以这个技能做的是另一件事：**读日志，找姿势问题**。

## 它怎么工作

1. 递归找 `~/.dsh/sessions/**/session*.jsonl.zstd`
2. 逐帧解压（**这里有个必踩的坑**：DSH 是追加式写入，每条记录一个独立 zstd 帧拼接；`zlib.zstdDecompressSync` 对多帧输入只解第一帧而且不报错，扫描器会静默返回 0 条。必须按 magic `28 B5 2F FD` 自己循环定位）
3. 从每条记录里挖出错误文本（`isError` / `type:error` / 已知错误码字面量）
4. 归一化后按错误码归类，统计次数、涉及工具、典型原文
5. 对照 `references/knowledge.json` 给出根因、先兆、修法

## 安装

技能形态，不需要 pnpm、不需要改 profile、不需要重启宿主。

```powershell
# 1. 克隆到技能目录
git clone https://github.com/shiliman/dsh-session-error-census "$HOME\.dsh\skills\dsh-session-error-census"

# 2. 验证
node "$HOME\.dsh\skills\dsh-session-error-census\selftest.mjs"
```

下一轮对话里，`skill` 工具就能加载它。

> 如果你的机器上 `node` 不在 PATH（DSH 自带运行时就是这样），用运行时的绝对路径：
> `$HOME\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`

## 用法

```powershell
$node = 'node'
$scan = "$HOME\.dsh\skills\dsh-session-error-census\scan.mjs"

& $node $scan --days 7                      # 最近 7 天（默认 30 天，最多 120 个文件）
& $node $scan --all                         # 全量（全部会话文件，约 30 秒）
& $node $scan --code FS_NOT_OBSERVED        # 查单个错误码的完整档案
& $node $scan --report                      # 写 Markdown 报告到 ~/.dsh/error-atlas/诊断-<日期>.md
& $node $scan --json                        # 机器可读
```

## 十二个错误码

| 错误码 | 严重度 | 一句话根因 |
|---|---|---|
| `FS_NOT_OBSERVED` | 高 | 改文件前没读 |
| `FS_STALE_VERSION` | 高 | 读完之后文件被改了 |
| `FS_EDIT_NOT_FOUND` | 高 | 替换串对不上 |
| `WEB_PROVIDER_ERROR` | 中 | 网络出口失败 |
| `SAFETY_NET_BLOCKED` | 中 | 被安全围栏拦下 |
| `ACL_WRITE_FAILED` | 中 | 沙箱授权写失败（出现即 pwsh 整体不可用） |
| `FS_NOT_FOUND` | 中 | 路径不存在 |
| `UNKNOWN_TOOL` | 低 | 工具不在当前工具表 |
| `EPERM` | 低 | 进程创建被拒 |
| `TIMEOUT` | 低 | 连接超时 |
| `ECONNRESET` | 低 | 对端重置 |
| `ENOENT` | 低 | 文件不存在 |

完整档案（根因 / 先兆 / 修法 / 涉及工具 / 典型原文）在 `references/knowledge.json`，用 `--code` 查。

## 三条读结果的判据

1. **看 Top 3 的占比，不看绝对数。** 超过 50% = 姿势问题，不是运气问题；这时候改动作比修单个 bug 收益大得多。
2. **分清「环境事实」与「操作失误」。** 有些码一出现就说明环境坏了（`ACL_WRITE_FAILED` = `SetNamedSecurityInfoW failed (Win32 5)`，`pwsh` 整个工具不可用），那不是做错了，是应该绕路。
3. **看「紧跟什么之后」。** 如果某个码总是紧跟在构建脚本之后，那是流程缺陷，应该改流程，不是改代码。

## 误判清单：看着像 bug，其实是设计

不是所有「不对劲」都是缺陷。**把设计当 bug 修，比不修更糟。**

当前收录 1 条（`references/knowledge.json` 的 `misdiagnoses`）：

### `chat-scroll-jump`：切会话自己往上滑

- **症状**：点会话切换进去，界面自己向上滑一段，要手动滑回底部。
- **像什么**：渲染完又重排 / 虚拟列表重算高度导致的滚动跳动。
- **其实是什么**：DSH 按会话记住阅读位置。`restore()` 里有记录就回到上次停的那条消息，只有没记录才落到底。
- **怎么分辨**：①只有「上次翻到中间就离开」的会话这样；②停的位置总是同一条消息，不随机；③切进去不动它，不会再往下漂。
- **别做什么**：别去改滚动容器、`toBottom`、虚拟列表高度。
- **真要做**：要每次都落底就清掉该会话的位置记录，代价是丢掉「接着看」。

通用判据：真缺陷的特征是**同一状态下重复同样操作，结果不稳定**；设计行为则稳定可复现，且能对应到源码里一个明确分支。

## 局限（写在这里，不藏在报告里）

1. **只覆盖落盘到日志的错误。** 调用前被拦、崩溃前没写盘的，扫不到。
2. **新形态的错误会落到「未识别」。** 不会自动进知识库，得人工补。
3. **历史频次是某个时间点的一次性画像**，代表过去，不代表当前环境状态。当前健康与否看 `dsh-health`。
4. **`classify()` 是文本特征匹配**，同一条错误可能被更早的规则抢走。改规则后必须重跑自检。

## 自检

```powershell
& $node "$HOME\.dsh\skills\dsh-session-error-census\selftest.mjs"
```

24 项断言：知识库完整性（含误判清单的结构与证据完整性）、12 种样本归类、真实日志扫描、报告目录可写。

## English summary

A DeepSeek Harness **skill** that turns your session logs into an error census: it walks every `session*.jsonl.zstd`, decodes each append-only zstd frame, classifies failures into 12 codes, and reports counts plus root cause / warning signs / fix for each. It also ships a *misdiagnosis* list — behaviours that look like bugs but are deliberate design (e.g. per-session scroll restoration).

Why: a health check tells you whether the environment is broken; this tells you whether **your own actions** keep breaking. Install into `~/.dsh/skills/`, no build step, no restart.

## License

MIT
