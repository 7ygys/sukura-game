# 散樱乱武 · 会话交接（AssetStudio 安装 → 现在）

> 写给「新会话」的你和 AI：这是上一个会话从**「AssetStudio 装哪个」**到**「官方发布页在哪」**的全部经过。
> 标了 ✅ 的是**已经确认的事实**，标了 ❓ 的是**还没核实/需要问用户的**，别把 ❓ 当成事实用。

---

## 0. 一句话背景

用户手上有一个 **Android 包**（`散樱乱武 2022.3.18f1`），用 **AssetStudio** 解开，能看到里面的卡牌图（带 `sample` 水印）。现在**新开会话要做这个游戏**——但「做什么」还没定义清楚（见 §7）。

---

## 1. 用户环境（✅ 已确认）

| 项 | 值 |
| --- | --- |
| 系统 | Windows 11，**x64**（Intel/AMD） |
| 主力盘 | `E:\`（`E:\Agent`、`E:\TotalLanguage`、`E:\codeblocks`、`E:\Tools` 等） |
| 工作区 | `E:\Agent\DeepSeek Harness\大肥鱼工作区` |
| **.NET** | 已装 **.NET Desktop Runtime 8.0.33 (x64)**；另有 .NET 10 SDK 在 `E:\TotalLanguage\C#\dotnet`（**但只有 NETCore.App，没有 WindowsDesktop**） |
| **Git** | ✅ 已装（安装过程卡过一次，后来自己恢复） |
| **代理** | ✅ Clash Verge Rev v2.5.8（x64-setup 版） |
| **GitHub 直连** | ❌ 不通（15s 超时） |
| **可用镜像** | ✅ `https://gh-proxy.com/`（实测 206/0.9s）；❌ ghfast.top 403、ghproxy.net/ghproxy.cc/moeyy/llkk 超时 |

**镜像用法**：`https://gh-proxy.com/https://github.com/...`
（注意：镜像能看到流量，**私仓/带 token 的请求绝对不要走镜像**）

---

## 2. 工具链（✅ 已就位）

- **AssetStudio v1.36**（perfare 老版，`AssetStudio.GUI.exe` + `AssetStudio.CLI.exe`）
  - ❓ **放在哪个目录了没确认**（建议按约定应在 `E:\Tools\AssetStudio\`，但用户实际放哪没见过）
  - 已知局限：对 **Unity 2022.3** 支持勉强，MonoBehaviour 一堆解析不了
  - 备选：**AssetRipper**（维护更活跃，新版本 Unity 更稳）
- **.NET 8 桌面运行时**：装完 `AssetStudio.GUI.exe` 能正常启动
- 目录约定（本次建议、❓ 用户是否采纳未知）：
  - 安装包 → `E:\Installers\`
  - 绿色软件 → `E:\Tools\`
  - 导出物 → 单独目录，别和程序混

---

## 3. 素材情况（✅ 用户截图确认）

- AssetStudio 里已加载 **`散樱乱武 - 2022.3.18f1 - Android`** 的资源
- 能看到 **Texture2D / Sprite / TextAsset / Shader / MonoBehaviour** 等类型
- 卡牌图例：**サイネ（Saine）「返し刃」**，底部编号 `NA-02-saine-O-N-3`，**卡面带 `sample` 水印**
- Debug Console 刷屏：
  ```
  [Info] Error while read type, read 40 bytes but expected 340 bytes
  ```
  **原因**：MonoBehaviour/脚本类需要 `Assembly-CSharp.dll` 或 IL2CPP 的 DummyDll，Android 包通常还剥掉了 TypeTree
  **影响**：**不影响贴图/Sprite 导出**（预览已正常显示卡面）
  **处理**：`Options → 取消 Show error message` 就不刷了；真要读脚本数据得走 Il2CppDumper + DummyDll

---

## 4. 导出方法（已给过的结论）

GUI 流程：
1. `Filter Type` → 勾 `Texture2D` + `Sprite`（卡牌建议**只勾 Sprite**，避免重复）
2. 列表里点一下 → `Ctrl+A`
3. `Export` → `Filtered assets`
4. 弹窗：输出目录 / `Group by = Container path`（按原路径分文件夹）/ **Image format = PNG**

**格式结论：PNG，不要 JPG。**
理由：卡牌上的小字用 JPG 会有压缩噪点；圆角/阴影可能要 alpha；以后要做 OCR/二次排版无损更稳。

❓ **用户到底导出了没有、导到哪、导了多少——未知。**

---

## 5. 官方渠道（✅ 已核实）

| 类型 | 地址 |
| --- | --- |
| **实体卡官网（日文）** | https://furuyoni.sekiseiro.com/ （版权 © 2026 **Sekiseiro**，美术 **TOKIAME**） |
| 制品情报 | https://furuyoni.sekiseiro.com/re/products/ |
| 卡牌一览 | https://furuyoni.sekiseiro.com/re/cardlist/ |
| 官方 X（实体） | https://x.com/sakurafuruyoni |
| **Steam 数字版** | https://store.steampowered.com/app/3446770/ |

Steam 版要点：
- 名称：**Sakura Arms ~Radiant Duels~ / 散樱乱武 ~绚烂竞演~**
- **社区开源模拟器起家 → 2024 年拿到 BakaFire Party 商业授权 → 整体重做**
- 开发者 BakaFire Party + The Sakura Scholar，发行 The Sakura Scholar
- **2026 年抢先体验**，现在有 Demo（App 4406150）
- **支持简体中文** ✔
- 官方 X：@SakuraArms_Duel

---

## 6. 版权与来源（⚠️ 新会话务必先确认）

- 用户手上那个 **Android APK 在官方渠道里没查到**（官方只有实体卡 + Steam）→ ❓ **来源不明，很可能不是官方发布**
- 卡面带 `sample` 水印 → 是官方宣传用的试样图
- 因此：**做二创/工具/展示可以，但不要商用、不要二次分发素材**；如果要做公开发布的东西，先说清边界

---

## 7. ❓ 还没定义清楚的事（新会话开场先问）

1. **「完成这个游戏」具体指什么？**
   - (a) 做一个 **HTML 端卡牌对战游戏**（参考工作区里的 `horror-bike` 风格：纯 Canvas、无素材）
   - (b) 做一个 **卡牌/资源浏览器**（把导出的图整理成可按女神/卡名检索的图鉴）
   - (c) 做 **素材处理工具**（批量裁切、去水印边框、重命名成 `NA-02-saine-O-N-3` 这种规范）
   - (d) 其它
2. **素材现在在哪？** 导出目录路径、大概多少张、有没有整理过
3. **要不要用真素材**（有版权风险），还是只**借用规则/卡名**、美术自己画
4. **单机还是联机**？纯前端还是需要后端？
5. 目标平台：浏览器 / 桌面 / 手机

---

## 8. 这个文件夹里已有什么

```
散樱乱武\
└─ 参考版本\
   └─ base.apk(1).1      ← 用户放的 APK（扩展名被改过，实际是 apk）
```

❓ APK 是否可解、版本是否就是 2022.3.18f1、里面有没有 TypeTree，都还没验。

---

## 9. 给新会话的操作建议

- **先读本文件，再问 §7 的五个问题，别急着动手。**
- 如果要碰 APK：先 `Get-FileHash` 记录一份，再复制一份出来动，**不要在原文件上操作**。
- 用户的 DSH 是**桌面端**，插件只能走 `plugin_manager`；命令行要 `danger-full-access` 授权才跑得动（默认会被沙箱挡住）。
- 用户在意「删除/不可逆操作要先列清单等确认」——这条是硬规矩。
- 工作区已有项目可以直接参考风格：`horror-bike`（纯 Canvas 恐怖游戏）、`mv-demo.html`（WebGL 时间函数动画）、`pelican-bicycle.svg`。

---

# 当前状态（2026-11-01 更新）

## 一句话

**单机（同屏双人）+ 联机对战都能玩**，44 张卡全部实装并对着卡面核过，
引擎有 1657 条断言（7 个测试文件）全绿。

## 怎么跑

```powershell
# 单机
双击 _work/prep.html → 同屏双人 → 选人 → 组卡 → 决斗

# 联机
两边都开 prep.html → 联机对战 → 创建房间 / 加入房间 → 交换邀请码
  → 随机分到各自的候选女神 → 选 2 位 → 组卡 → 决斗

# 测试
node game/tests/run_all.js
```

## 代码地图

| 路径 | 作用 |
| --- | --- |
| `game/engine/*.js` | 规则引擎（纯 JSON 状态，浏览器/Node 共用） |
| `game/tests/*.js` | 332(回归) + 360(战斗) + 407(流程) + 247/243(卡牌) + 57(联机) + 11(压缩) |
| `net/*.js` | 联机：压缩、状态降级、协议、WebRTC、会话 |
| `_work/prep.html` | 主界面 + 大厅 + 选人 + 组卡 + **持有连接** |
| `_work/scene_v17.html` | 战斗页（可被 iframe 嵌入） |
| `data/cards.json` | 44 张卡数据（**卡面图是唯一真相**） |
| `docs/开发守则.md` | 踩坑全表 / 机制清单 / 44 张卡检查要点 |
| `讨论记录.md` | 41 个阶段的决策与事故记录 |

## 已知限制

- **同一台电脑开两个窗口**联机不稳定（都是本机候选），建议两台设备 / 手机热点
- 掉线**不做重连**（只提示），这是当初定的
- `要返し` 的"至多 2 张"是自动取前两张，还没给玩家挑
- 人机对战只有占位按钮
- 距离扩大/缩小按官方实现（改的是《攻击》适正距离，不是间合）

## 如果下次要接着做

1. **AI 对手**（人机按钮还空着）
2. `要返し` 的选牌交互
3. 联机断线重连
4. 更多女神 / 更多卡
