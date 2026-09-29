# ChatGPT Jump to Prompt

在 chatgpt.com 长对话中快速跳回自己提问过的位置：一键滚到最后一条提问，或在历史提问之间逐条上下导航。纯前端、无网络请求、无数据收集、无构建步骤。

## 功能

- **Alt+J** — 平滑滚动到当前对话中最后一条用户提问的顶部
- **Alt+↑ / Alt+↓** — 在用户提问之间向上 / 向下逐条导航
- 跳转后对目标消息做约 1.5s 的呼吸边框高亮，防止视觉丢失
- 页面右侧浮动小圆标：显示当前位置（如 `第 3/15 条提问`），点击 = 跳到最后一条；`×` 可隐藏（刷新恢复）
- SPA 兼容：侧边栏切换对话不刷新页面，导航状态自动重置；MutationObserver 监听新消息
- 找不到提问时弹出 toast 提示，并保底滚动到输入框（不静默失败）

## 安装

1. `git clone` 本仓库（或下载 zip 解压）
2. 打开 `chrome://extensions`
3. 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择本目录

> 如果安装前就已经打开了 chatgpt.com 标签页，无需刷新——首次按快捷键时扩展会自动补注 content script。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt+J` | 跳到最后一条提问 |
| `Alt+↑` | 上一条提问 |
| `Alt+↓` | 下一条提问 |

修改方式：`chrome://extensions/shortcuts`（或扩展页左上角菜单 → 键盘快捷键）里找到 "ChatGPT Jump to Prompt" 自行改键。

注意：
- 这三个快捷键是**浏览器全局**的，即使在非 chatgpt.com 页面也会先被扩展捕获（扩展内部会检查当前标签页 URL，不匹配则忽略）。若与其他站点/系统快捷键冲突，请在上述页面改键。
- macOS 上默认也是 `Option+J` / `Option+↑` / `Option+↓`，可在同一页面改为其他组合。

## 工作原理

- `manifest.json` 的 `commands` 声明快捷键；`background.js`（极简 service worker）把命令通过 `tabs.sendMessage` 转发给当前标签页的 `content.js`。
- `content.js` 负责全部 DOM 操作：收集用户消息 → `scrollIntoView({behavior:'smooth'})` → 高亮 + 更新角标。
- 对话切换检测：`popstate` + Navigation API `navigate` 事件 + 1s URL 轮询三重保险；切换后重置"当前位置"。
- "当前位置"保存的是**元素引用**而非下标，虚拟化列表插入/移除节点不会导致索引错位。

## 选择器维护指南（失效时如何更新）

ChatGPT 是 React SPA，DOM 结构会随版本变化。所有选择器集中在 `content.js` 顶部常量区：

```js
const USER_MESSAGE_SELECTORS = [
  '[data-message-author-role="user"]',   // 主选择器：消息节点上的角色属性
  '[data-turn="user"]',                  // 备选：turn 包装 <article> 上的角色属性
];
```

**排查步骤：**

1. 在 chatgpt.com 对话页按 F12 打开 DevTools
2. 在 Elements 中选中一条"你发出的消息"，逐级向外看，找到稳定标识该消息是用户消息的 attribute（例如 `data-message-author-role`、`data-testid`、`data-turn` 之类）
3. 把新选择器加到 `USER_MESSAGE_SELECTORS` 数组**最前面**（数组按优先级 fallback，第一个匹配到结果的生效）
4. 同样地，如果输入框定位失效，更新 `COMPOSER_SELECTORS`
5. 保存后无需重装——`chrome://extensions` 里点扩展卡片上的"刷新"按钮即可

**最后一道兜底：** 当所有 attribute 选择器都失效时，`heuristicUserTurns()` 会扫描 `<article>`，把"不含 assistant 节点、且含右对齐气泡（justify-end 等 Tailwind 特征类）"的块当作用户提问。这只是尽力而为的猜测；再失败则滚动到输入框并 toast 提示。

## 已知限制

- **只导航 DOM 中已渲染的消息。** ChatGPT 对超长对话做虚拟化，未渲染的历史提问不在 DOM 里，扩展不强制加载它们（`共 N 条`显示的也是已渲染条数）。
- 手动滚动浏览后再按 `Alt+↑/↓`：若之前没有跳转记录，会以"视口顶部参考线"为基准找上/下一条，行为可能与直觉略有差异。
- `chat.openai.com` 域名会跳转 `chatgpt.com`，扩展两个域名都声明了，正常无需关心。
- 扩展不向任何服务器发请求；唯一的权限是 `scripting`（用于安装前已打开页面时的补注入）+ `chatgpt.com` 的 host 权限。

## 文件结构

```
manifest.json   MV3 清单（命令、content script、权限）
background.js   service worker：chrome.commands → 转发给 content script
content.js      全部逻辑：消息定位、滚动、高亮、角标、toast、SPA 监听
content.css     高亮动画、浮动角标、toast 样式
icons/          16/48/128 PNG 图标
```
