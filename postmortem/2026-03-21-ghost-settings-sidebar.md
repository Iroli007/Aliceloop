# Postmortem: "幽灵"设置侧边栏删不掉事件

**日期**: 2026-03-21
**严重级别**: P1 (严重影响开发效率，累计浪费多个 AI session 的调试时间)
**状态**: 已修复

---

## 事故摘要

设置弹窗的左侧导航栏 (sidebar) 和底部的"设置"/"语言"按钮无论怎么修改源码都无法消失，多个 AI session 反复尝试删除均失败。最终发现是三个独立 bug 叠加导致的"完美风暴"。

---

## 事故原因

### 根因 1: 环境变量名错误 (致命)

`src/main/index.ts` 和 `src/main/settingsWindow.ts` 中使用了错误的环境变量名：

```typescript
// 错误: Electron Forge 的命名规范
const devServerUrl = process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL;

// 正确: electron-vite 实际注入的变量名
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
```

**后果**: `devServerUrl` 永远为 `undefined`，Electron 在 dev 模式下回退加载 `dist/renderer/index.html`（旧的构建产物），而不是 Vite dev server。**所有源码修改在 dev 模式下完全不生效。**

**引入 commit**: `b7fe42e` feat: release v1.0 - session stream, tool approval, and runtime settings
**修复方式**: 将两处 `MAIN_WINDOW_VITE_DEV_SERVER_URL` 替换为 `ELECTRON_RENDERER_URL`

### 根因 2: 设置 UI 代码存在两份独立副本

设置弹窗的完整 UI（包括侧边栏、tab 切换、所有面板）存在于两个完全独立的文件中：

| 文件 | 用途 | 渲染位置 |
|------|------|----------|
| `src/renderer/src/features/shell/ShellLayout.tsx` | 主窗口内嵌的设置 modal | 主窗口 overlay |
| `src/renderer/src/features/settings/SettingsPanel.tsx` | 独立设置窗口 | 独立 Electron BrowserWindow |

所有 AI session（包括本次初期）都只在 `ShellLayout.tsx` 中修改，而用户实际看到的设置界面是从 `SettingsPanel.tsx` 渲染的独立窗口。**改错了文件。**

`ShellLayout.tsx` 中的设置代码甚至已经被前一个 AI session 用 `{false && isSettingsOpen}` 硬性禁用了，但因为根因 1，这个修改也没有生效。

**引入 commit**: 多个 AI session 在不同时间各自创建了设置 UI，未意识到另一份的存在
**修复方式**: 两个文件都进行了侧边栏移除和瀑布流重构

### 根因 3: 旧构建产物中包含已删除的代码

`dist/renderer/assets/App-BxJ32iNo.js` 中包含了源码中已不存在的代码：

```javascript
// 这些代码在源码中已被删除，但 dist 中仍然存在
jsx("footer", { className: "sidebar__footer", ... })
jsx("span", { className: "sidebar__settings-label", children: "设置" })
jsx("button", { className: "sidebar__settings-popout-item", children: "语言" })
```

因为根因 1，Electron 一直加载这个旧文件，所以"设置"和"语言"按钮永远存在。

**修复方式**: `rm -rf dist` 清除旧构建产物

---

## 附带发现的问题

### 问题 4: 全角引号污染

`ShellLayout.tsx` 中有 157 处全角引号 `"""`（Unicode `U+201C` / `U+201D`），来源于从聊天/文档中复制粘贴的代码片段被 AI 直接写入源文件。导致 Babel 解析报错。

**修复方式**: `sed` 批量替换为半角引号

### 问题 5: 多个文件被重复粘贴

`SettingsPanel.tsx` 和 `desktopBridge.ts` 的文件内容被完整复制了两遍（文件末尾附加了一份完整副本），是之前 AI 编辑留下的"疤痕"。

**修复方式**: 重写为干净的单份内容

### 问题 6: 大量死代码

删除侧边栏后，以下代码变为死代码：
- `settingsNav` 导入和数据源（`nav.ts`）
- `activeSettingsTab` 状态及所有条件渲染
- `useProviderConfigs` hook 及全部 provider 相关状态
- `handleSaveProvider` 函数
- `primaryNav`、`dockNav` 导出（从未被 import）

**修复方式**: 从 `SettingsPanel.tsx` 中清除所有死代码

---

## 复现步骤

1. 运行 `npm run dev`（`electron-vite dev`）
2. 观察 Electron 窗口 — 加载的是旧 `dist/` 产物而非 Vite dev server
3. 修改任何 renderer 源码 — 界面无变化
4. 尝试删除设置侧边栏 — 无论怎么改都"删不掉"

## 验证修复

1. 修正 `ELECTRON_RENDERER_URL` 环境变量名
2. `rm -rf dist`
3. 重新 `npm run dev`
4. 确认 Electron 加载 `http://localhost:5173/`
5. 确认"设置"/"语言"按钮消失
6. 确认设置弹窗改为无侧边栏的瀑布流布局

---

## 涉及的 Commits

| Commit | 内容 | 与本事故的关系 |
|--------|------|----------------|
| `b7fe42e` | feat: release v1.0 | 引入了错误的环境变量名 `MAIN_WINDOW_VITE_DEV_SERVER_URL` |
| `77699b6` | fix: restore settings panel scrolling | 可能引入了 `SettingsPanel.tsx` 独立副本 |
| `d7116ce` | feat: unify mac title bar controls | 重构了 WindowControls，但未统一两份设置 UI |
| `97dd595` | feat: adjust window position | 调整了窗口尺寸，未触及核心问题 |
| (未提交) | 本次修复 | 修正环境变量、删除侧边栏、清理死代码、修复全角引号 |

---

## 经验教训

### 1. Dev 模式必须验证热更新是否真的生效

**规则**: 每次搭建新的 Electron + Vite 项目后，第一件事是验证 HMR 链路：改一行文字 -> 确认界面刷新。如果 dev 模式加载的是 dist 产物，所有后续开发都是在做无用功。

### 2. 环境变量名必须与构建工具文档对齐

`electron-vite` 用 `ELECTRON_RENDERER_URL`，`Electron Forge` 用 `MAIN_WINDOW_VITE_DEV_SERVER_URL`。混用会导致静默失败——不报错，只是回退到 fallback 路径。

**预防**: 在 `createWindow` 中添加 dev 模式启动日志：
```typescript
if (devServerUrl) {
  console.log(`[main] Loading from dev server: ${devServerUrl}`);
} else {
  console.warn(`[main] ELECTRON_RENDERER_URL not set, falling back to dist/`);
}
```

### 3. 禁止同一 UI 存在两份独立实现

设置面板被实现了两次（`ShellLayout.tsx` 内嵌版 + `SettingsPanel.tsx` 独立窗口版），导致修改一处时另一处不受影响。

**预防**: 抽取共享组件，两个入口点引用同一份代码。

### 4. AI 辅助编码必须验证写入的字符编码

从聊天/文档中复制的代码可能包含全角引号、全角空格等不可见的 Unicode 字符。AI 直接将用户消息中的代码片段写入源文件时，必须确保字符编码正确。

**预防**: 在 CI 中添加 lint 规则检测非 ASCII 引号。

### 5. 构建产物不应提交到 git

`dist/` 目录包含旧的编译结果，如果被 git 追踪或残留在磁盘上，会成为"幽灵代码"的藏身之处。

**预防**: 确保 `.gitignore` 包含 `dist/`，CI pipeline 中始终从 clean state 构建。

---

## 如何避免再次出现

- [ ] 在 `createWindow` 和 `createSettingsWindow` 中添加 dev server URL 日志
- [ ] 将 `SettingsPanel.tsx` 和 `ShellLayout.tsx` 中的设置 UI 统一为共享组件
- [ ] 添加 ESLint 规则检测非 ASCII 引号字符
- [ ] 确认 `.gitignore` 包含 `dist/`
- [ ] 在 CLAUDE.md 中记录：修改 renderer UI 后必须确认 HMR 生效
