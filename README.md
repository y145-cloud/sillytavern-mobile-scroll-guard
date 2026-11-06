# 手机流式滚动守护 (Mobile Scroll Guard)

给 SillyTavern 用的第三方扩展。解决的问题：**手机/TauriTavern（WebView 壳）上，AI 正在流式输出时，你往下翻看已经吐出来的内容，画面会跳回「本楼最开头」；电脑上正常。**

不删除、不修改任何别的扩展文件，也不改 ST 核心代码。

---

## 一、为什么会跳（排查结论）

先说结论：**不是单个插件干的，是手机上三个力叠在一起。**

| # | 来源 | 具体行为 |
|---|------|----------|
| 1 | 柏宝箱 ST-BaiBai-Tools 的「生成结束定位到最新消息开头」 | 生成结束时把 `#chat.scrollTop` 设成「最新一条消息的开头」放到离顶部 18% 的位置（`LATEST_MESSAGE_TOP_OFFSET_RATIO = 0.18`）。这个目标位置**字面上就是本楼开头**。 |
| 2 | 柏宝箱的「长聊天渲染优化」 | 生成期间给 `#chat` 子元素加 `overflow-anchor: none`，关掉浏览器原生滚动锚定；同时给消息加 `content-visibility: auto` + `contain-intrinsic-size`。手机 Chrome/WebView 上占位高度估算会来回变，又没有锚定补偿 → 内容自己往上/往下跳。 |
| 3 | SillyTavern 核心的 `#chat` 高度 | `public/style.css` 里是 `max-height: calc(100vh - ...)`，用 `100vh` 而不是 `100dvh`。手机地址栏伸缩时 `#chat` 比可视区高，滚动会链到整个页面上，手势判定和 scrollTop 基准全乱。上游 PR #6060 正是修这个。 |

另外 ST 核心默认 `stream_fade_in = false` 时，每个 token 都是整块 `innerHTML` 替换（`public/script.js` 的 `StreamingProcessor`），文本节点每帧重建一次 —— 所以**任何按文本节点记位置的方案都会失效**，本扩展用消息元素 `.mes` 当锚点。

**注意**：以上都是「找得到的力」，没法 100% 断定你手机上的那一下是哪一个（WebView 内核差异太大）。所以本扩展的策略不是「修某个插件」，而是**「不管谁在动，读的时候都别动我」**。

---

## 二、它怎么修

只在「**生成中 + 你已经离开底部**（说明你在读）」时进入**阅读锁定**：

1. **拦截**：包住 `Element.prototype.scrollTop` 的 setter（以及 `scrollTo` / `scrollBy` / `scrollIntoView`），锁定期间丢掉其他脚本对 `#chat` 的强制跳转。
2. **锚点补偿**：每帧取「视口顶部那条消息」做锚点，内容高度变化导致的位移补回去（含 `content-visibility` 造成的抖动、上方消息异步渲染变高）。
3. **恢复原生滚动锚定**：锁定期间把 `#chat > *` 的 `overflow-anchor` 强制回 `auto`。
4. **修高度**：`#chat` 的 `max-height` 改用 `100dvh`，并 `overscroll-behavior: contain` 阻断滚动链。

**你一滑回底部，立刻全部放手** —— ST 自己的自动跟随、柏宝箱「生成结束定位到本楼开头」在你不读的时候照旧生效。

---

## 三、安装

> 仓库：https://github.com/y145-cloud/sillytavern-mobile-scroll-guard （私有）
> 更新：进目录 `git pull` 即可；本扩展不写 ST 设置文件，升级不会动你的设置。

### 方法 A：解压到扩展目录（推荐，最稳）

把整个 `st-mobile-scroll-guard` 文件夹放到：

```
<SillyTavern 根目录>/public/scripts/extensions/third-party/st-mobile-scroll-guard/
```

要求该目录里能直接看到 `manifest.json`、`index.js`、`style.css` 三个文件。然后刷新酒馆页面（手机端重启 App）。

### 方法 B：UI 安装

扩展菜单 →「安装扩展」→ 上传本目录打好的 zip（扩展管理器支持 zip 时会自动解压到 `third-party/`）。

### 安装后检查

浏览器控制台应该出现：

```
[STMSG] 已加载 { touch: true, settings: {...} }
```

扩展设置面板（魔棒图标 → 扩展）里能看到「手机流式滚动守护」，共 9 个开关。

---

## 四、设置项

| 开关 | 默认 | 说明 |
|------|------|------|
| 启用 | ✅ | 总开关 |
| 仅在触屏设备生效 | ✅ | 关掉它电脑上也会生效（调试用） |
| 拦截其他扩展的强制跳转 | ✅ | 锁定期间丢弃 `#chat` 的 scrollTop 写入 |
| 补偿内容高度变化导致的位移 | ✅ | 锚点补偿 |
| 恢复浏览器原生滚动锚定 | ✅ | `overflow-anchor: auto` |
| 修正手机端 #chat 高度 | ✅ | `100vh` → `100dvh` |
| 显示锁定提示按钮 | ✅ | 右下角小胶囊：锁定中显示拦截计数，点一下解除；再点一下恢复 |
| 滑回底部后自动恢复守护 | ✅ | 你滑到底部看新内容时清除「手动解除」，下次上翻重新锁定 |
| 调试日志 | ⬜ | 控制台打印拦截/补偿细节 |

面板里还有「诊断」按钮，输出当前状态 JSON：距底部像素、拦截次数、补偿次数、锚点消息、柏宝箱长聊天优化是否在生效等。

排查用命令（控制台）：

```js
window.stMobileScrollGuard.report()   // { locked, blockedWrites, corrections, engagements }
window.stMobileScrollGuard.settings   // 运行时设置（改完记得面板里点一下，或用 saveSettings）
```

---

## 五、验证你是不是踩到这个坑（三步）

1. 打开柏宝箱设置 → **关掉**「生成结束定位到最新消息开头」和「长聊天渲染优化」→ 复测手机流式输出。
   - 不跳了 → 就是它，你可以选择只关它，或者装本扩展后用它的定位功能。
   - 还跳 → 继续第 2 步。
2. 装上本扩展 → 流式输出时往上翻。
   - 不跳了 → 收工。
   - 还跳，右下角出现 🔒 胶囊却还是跳 → 点扩展设置里的「诊断」，把那段 JSON（尤其「拦截调用栈」）截图发我。
3. 想确认是哪一次写入在捣鬼：打开「调试日志」，锁定期间每次被拦的写入都会打印 `拦截 scrollTop 写入: 12345`。

## 六、更新日志

- **1.1.0**
  - 修掉「点一下解除后按钮消失、本次生成内再也锁不回来」：按钮改为**生成期间常驻、双向切换**（锁定中 ↔ 已解除）。
  - 修掉锁定期间**误吞用户手势**的 bug：以前用 150ms 时间窗判断「是不是自己写的 scroll」，流式时几乎每帧都在补位置、时间窗永远新鲜，结果用户滑动全被当成自己的写入 → 表现为「怎么滑都被拽回去」。现在改为比对写入后的目标位置（±2px）。
  - 新增 `MutationObserver`：盯着正在输出的那条消息，DOM 一变就下一帧补位置，专门对付「没有 scrollTop 写入、纯靠重排把内容顶上去」的跳法。
  - 底部判定 64px → 40px，减少「差一点没到底所以没放手」的粘滞感。
  - 诊断面板新增**拦截调用栈**（前 5 次），能直接看出是哪个脚本在抢 `scrollTop`。
- **1.0.1** 首个可用版本。

## 七、回滚

删掉 `public/scripts/extensions/third-party/st-mobile-scroll-guard/` 整个文件夹，刷新页面即可。本扩展不写任何 ST 设置文件，只在 `localStorage` 里存一个 `stmsg.settings.v1`。

## 八、已知限制

- 只在**生成窗口内**（生成中 + 结束后 2.4 秒宽限期）守护；平时翻历史不受影响，也不会被保护。
- 如果别的扩展在**截图/触摸结束瞬间**用 CSS `transform` 位移而不是 scrollTop，本扩展看不到（目前没发现这种实现）。
- 与柏宝箱的 `Element.prototype.scrollTop` 补丁共存：它加载更早（`loading_order = -1000`），我们包在它外面。它的「消息编辑滚动守卫」若在编辑态激活，可能把我们补偿用的写入也丢掉 —— 编辑消息时本来也不该锁定，属可接受。
