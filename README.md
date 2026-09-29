# ChatGPT Jump to Prompt

在 chatgpt.com 长对话中快速跳回自己提问过的位置：一键滚到最后一条提问，或在历史提问之间逐条上下导航。纯前端、无网络请求、无数据收集、无构建步骤。

**一份代码，两种形态**：核心文件 `chatgpt-jump.user.js` 同时是 Chrome 扩展的 content script 和可直接安装的 userscript（iOS Safari 适用），见下文安装方式。

## 功能

- **Alt+J** — 平滑滚动到当前对话中最后一条用户提问的顶部
- **Alt+↑ / Alt+↓** — 在用户提问之间向上 / 向下逐条导航
- 跳转后对目标消息做约 1.5s 的呼吸边框高亮，防止视觉丢失
- 页面右侧浮动控件：`↑` 上一条 / `第 k/N 条`（点击=跳到最后一条）/ `↓` 下一条 / `×` 隐藏（刷新恢复）。触屏设备上按钮自动加大，这是 iOS 上的唯一入口
- SPA 兼容：侧边栏切换对话不刷新页面，导航状态自动重置；MutationObserver 监听新消息
- 找不到提问时自动重试一次，仍失败则滚动到输入框并 toast 提示，同时向控制台输出诊断信息（不静默失败）

## 安装 — 桌面 Chrome 扩展

1. `git clone` 本仓库（或下载 zip 解压）
2. 打开 `chrome://extensions`
3. 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择本目录

> 如果安装前就已打开 chatgpt.com 标签页，无需刷新——首次按快捷键时扩展会自动补注脚本。

## 安装 — iOS Safari（userscript）

iOS 上 Chrome/Firefox 不支持扩展；Safari 的 WebExtension 必须走 App Store 打包，成本高。推荐 userscript 路线，免费可用：

1. App Store 安装 [**Userscripts**](https://apps.apple.com/app/userscripts/id1463298887)（免费开源）或 Stay
2. 打开 Safari 访问本文件的 raw 地址，Userscripts 会弹出安装提示：
   `https://raw.githubusercontent.com/liqiangcc/chatgpt-jump-to-prompt/main/chatgpt-jump.user.js`
   （也可以：设置 → Userscripts → 指定脚本目录，把该文件放进去）
3. iOS 设置 → Safari → 扩展 → 启用 Userscripts，并允许其在 chatgpt.com 上运行
4. 打开 chatgpt.com，用右侧浮动按钮的 ↑/↓ 导航（外接键盘时 Alt+J/Alt+↑/↓ 同样有效）

桌面端的 Violentmonkey/Tampermonkey 用户也可以直接装这个 .user.js，行为一致。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt+J` | 跳到最后一条提问 |
| `Alt+↑` | 上一条提问 |
| `Alt+↓` | 下一条提问 |

修改方式：`chrome://extensions/shortcuts` 里找到 "ChatGPT Jump to Prompt" 自行改键。

注意：
- 快捷键是**浏览器全局**的，在非 chatgpt.com 页面也会先被扩展捕获（内部会检查标签页 URL，不匹配则忽略）。冲突时请在上述页面改键。
- 页面内还有一道 keydown 兜底：当某个命令**没有绑定**快捷键（绑定失败或浏览器冲突）时，由页面直接监听。已绑定/被手动解绑的命令不受兜底影响——解绑即真正关闭。
- macOS 默认 `Option+J` / `Option+↑` / `Option+↓`，同样可改。

## 工作原理

- `manifest.json` 声明 commands；`background.js`（极简 service worker）把命令经 `tabs.sendMessage` 转发给 `chatgpt-jump.user.js`。
- `chatgpt-jump.user.js` 是全部逻辑所在。运行时自检 `chrome.runtime.id`：存在 = 扩展模式（命令走消息通道 + manifest 注入 CSS）；不存在 = userscript 模式（keydown 兜底 + `GM_addStyle`/`<style>` 注入内嵌样式）。
- 对话切换检测：`popstate` + Navigation API `navigate` 事件 + 1s URL 轮询三重保险。
- "当前位置"保存**元素引用**而非下标，虚拟化列表插入/移除节点不会导致索引错位。
- **Hydration 安全闸门（重要）**：chatgpt.com 是 Remix 式整文档 hydration（`hydrateRoot(document, ...)`）。在水合窗口内向 document 注入任何节点都会触发 React #418/#423 崩溃并使整页客户端重渲染。因此所有 DOM 写入（浮动控件、toast、高亮、userscript 的样式注入）都排队等待闸门打开：DOM 静默 ≥700ms 且（检测到 React fiber 标记或已过 4s），上限 8s。副作用是页面加载后浮动控件约 1–4s 才出现、此期间快捷键会排队执行——这是刻意为之的正确性取舍。若我们的节点仍被 React 重渲染擦掉，MutationObserver 会自动重建。

## 排查："没识别到提示词"怎么办

按 Alt+J 后如果弹出 `当前对话未找到提问`：

1. **按 F12 打开控制台**——脚本会自动输出一条 `[ChatGPT Jump to Prompt] 未找到用户提问` 诊断日志，里面有每个选择器的命中数和一段真实 DOM 样本
2. 常见情况：
   - `probes` 里所有选择器都是 0 且 `article` 也是 0 → 对话还没渲染完，稍等再按
   - `article` > 0 但 `data-message-author-role` 全 0 → OpenAI 改了标记，看下面的选择器维护指南
3. 把诊断对象内容发给开发者即可定位新选择器

## 选择器维护指南

所有选择器集中在 `chatgpt-jump.user.js` 顶部常量区，分三层 fallback：

```js
USER_MESSAGE_SELECTORS   // A: 直接命中"用户消息"节点的角色属性
TURN_ROOT_SELECTORS      // C: 先枚举 turn 包装器，再逐块用 classifyUserTurn() 判定
// D: 以上全空时，heuristicUserTurns() 扫描所有 <article>
```

`classifyUserTurn()` 的证据链（从显式到启发式）：`data-turn`/`data-role` 属性 → 后代角色节点 → `<h5.sr-only>`（用户）/`<h6.sr-only>`（AI）的无障碍标题 → "右对齐气泡且无 markdown 正文"的布局特征。

**更新步骤**：DevTools 里选中一条你发的消息 → 向外找到标识角色的 attribute → 把新选择器加进 `USER_MESSAGE_SELECTORS` 最前面 → `chrome://extensions` 点扩展卡片的刷新按钮（userscript 则直接刷新页面）。

输入框定位失效则更新 `COMPOSER_SELECTORS`。

## 已知限制

- **只导航 DOM 中已渲染的消息。** ChatGPT 对超长对话做虚拟化，未渲染的历史不在 DOM 里（`N 条`显示的也是已渲染条数）。
- 手动滚动后再按 `Alt+↑/↓`：没有跳转记录时以视口顶部参考线为基准找上/下一条。
- iOS userscript 模式下没有可改键的入口（靠浮动按钮）；外接键盘时 Alt+J/↑/↓ 有效。
- 扩展不请求网络、不收集数据；权限仅 `scripting`（补注入用）+ chatgpt.com host 权限。

## 文件结构

```
manifest.json          MV3 清单（命令、content script、权限）
background.js          service worker：commands 转发 + 补注入 + 汇报已绑定快捷键
chatgpt-jump.user.js   ★ 唯一逻辑文件：扩展 content script 兼 userscript
content.css            样式（扩展路径专用，与文件内嵌 CJP_CSS 保持同步）
icons/                 16/48/128 PNG 图标
test/                  测试（jsdom 单测 + 真 Chrome E2E + hydration 复现），与扩展无关
```
