# PTA 粘贴解锁器 (Paste Unlocker)

> Tampermonkey 脚本 —— 为 [拼题 A (pintia.cn)](https://pintia.cn) 解除复制 / 剪切 / 粘贴 / 右键 / 框选 / 拖拽限制

---

## ✨ 功能

| 能力 | 说明 |
|---|---|
| 粘贴解锁 | 核心功能：绕过"禁止粘贴"检测，真正把文本写入代码编辑器 |
| 复制解锁 | 允许框选 + Ctrl+C 复制题干、代码、测试用例等所有文本 |
| 右键解锁 | 右键菜单恢复，便于审查元素 |
| 拖拽解锁 | 允许拖选、拖放文本 |
| 实时状态面板 | 右下角常驻小面板，显示脚本是否激活、用什么方式写入、写入了多少字符 |

## 🎯 为什么它能用？

PTA 禁止粘贴的做法是多层防御：

```
第一层  window 捕获阶段 stopImmediatePropagation 拦截 copy/cut/paste/contextmenu
第二层  beforeinput 拦截 insertFromPaste 类型
第三层  CSS user-select: none 禁止文本选择
第四层  内联 oncopy/onpaste 属性
```

本脚本的破解策略：

| 步骤 | 做法 |
|---|---|
| 1 | `@run-at document-start` 注入，比 PTA 自身脚本先跑 |
| 2 | 在 `window` 捕获阶段注册监听器，先于 PTA 的监听器执行 `stopImmediatePropagation` |
| 3 | 从 `e.clipboardData` 读文本，然后自己**手动写入编辑器** |
| 4 | 写入时**优先走编辑器官方 API**（CodeMirror 6 的 `view.dispatch`），完全绕过粘贴检测层 |
| 5 | API 不可用时**逐字符 `execCommand('insertText')`** 模拟键盘输入，输入事件序列与真实打字一致 |

## 📦 安装

### 1. 浏览器扩展

- **Chrome / Edge**：[Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)（免费）
- **Firefox**：[Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) 或 [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/)
- **Safari**：[Tampermonkey](https://apps.apple.com/us/app/tampermonkey/id1482490119)（需 macOS 13+）

### 2. 安装脚本

1. 扩展装好后，点击 Tampermonkey 图标 → **添加新脚本**
2. 清空编辑器里的默认模板（全选 → 删掉）
3. 把仓库里 [`pta-paste-unlock.user.js`](./pta-paste-unlock.user.js) 的内容整段粘贴进去
4. **按 Ctrl+S 保存**（重要！没保存等于没装）
5. 打开 `https://pintia.cn/problem-sets/dashboard` 刷新页面

### 3. 验证

页面右下角应该出现一个深色小面板，显示：

```
脚本加载完成，URL=/problem-sets/xxx/exam/problems/...
>>> 粘贴解锁器 已激活 <<<
📝 考试页
```

如果什么都没出现，检查 Tampermonkey 图标上是否有红色数字（表示有报错），以及该脚本是否在扩展面板里被**启用**。

## 🚀 使用

### 常规使用

直接 Ctrl+C 复制、Ctrl+V 粘贴即可，脚本会自动处理。面板里会实时显示每次写入的详情（绿色 = 成功，红色 = 失败）。

### 快捷键

| 快捷键 | 作用 |
|---|---|
| `Alt + Shift + P` | 手动重新检测当前页面并激活（SPA 路由异常时有用） |
| `Alt + Shift + M` | 切换面板显示/隐藏 |

### Console 调试 API

右下角面板可能挡答题，可以用 F12 打开 Console：

```js
// 查看当前状态
__ptaUnlocker.diag()

// 手动从剪贴板写入当前焦点元素（不依赖粘贴事件触发）
__ptaUnlocker.paste()

// 启用/停用
__ptaUnlocker.enable()
__ptaUnlocker.disable()
```

## 🧩 编辑器支持

| 编辑器 | DOM 选择器 | 写入方式 | 稳定性 |
|---|---|---|---|
| **CodeMirror 6**（主要） | `.cm-editor` | `view.dispatch({ changes })` | ⭐⭐⭐⭐⭐ |
| **CodeMirror 5** | `.CodeMirror` | `CodeMirror.replaceSelection()` | ⭐⭐⭐⭐ |
| **Monaco** | `.monaco-editor` | `editor.executeEdits()` | ⭐⭐⭐⭐ |
| contenteditable DIV | `contenteditable="true"` | 逐字符 `execCommand('insertText')` | ⭐⭐⭐ |
| 原生 input/textarea | `TEXTAREA / INPUT` | `execCommand('insertText')` + value setter 兜底 | ⭐⭐⭐⭐⭐ |

## 📐 架构

```
pta-paste-unlock.user.js
├── 0. 域名守卫          —— 非 pintia.cn 直接 return，零副作用
├── 1. 浮动状态面板       —— 右下角常驻，实时显示脚本状态
├── 2. 页面类型检测       —— URL 路径特征：/exam/ → exam，/problem-sets/dashboard → dashboard
├── 3. 编辑器实例查找     —— 从 DOM 根向上遍历找 CodeMirror 6 的 cmView/view
├── 4. 文本写入引擎       —— 按编辑器类型路由：
│   ├── CodeMirror 6 API
│   ├── CodeMirror 5 API
│   ├── Monaco API
│   └── 逐字符 execCommand 模拟键盘
├── 5. 事件拦截层         —— window 捕获阶段 stopImmediatePropagation
├── 6. 激活/停用控制      —— SPA 路由感知（pushState/replaceState/popstate Hook）
├── 7. 快捷键             —— Alt+Shift+P 手动重检测，Alt+Shift+M 隐藏面板
├── 8. 启动入口           —— document-start 注入，DOM 就绪后 checkPage
└── 9. Console 调试 API  —— window.__ptaUnlocker
```

## ⚠️ 风险提示

| 项目 | 说明 |
|---|---|
| 前端 vs 后端 | 本脚本**只解除前端限制**；考试作答可能有服务端行为记录（如粘贴频率、输入速度异常） |
| 考试作弊 | 在考试页面绕过粘贴限制用于作弊，**风险由使用者自行承担**。建议仅用于：个人练习、课程作业、自我学习场景 |
| 脚本误注入 | 已做域名守卫 + 页面类型检测，不会影响 pintia.cn 以外的任何网站 |

## 🔧 FAQ

### Q: 右下角面板没出现？

1. 检查 Tampermonkey 扩展是否**已启用**（工具栏图标 → 第一个开关）
2. 检查脚本是否**已保存**（Tampermonkey → 该脚本 → 编辑器里按 Ctrl+S）
3. 检查脚本是否**被禁用**（Tampermonkey → 该脚本 → 顶部的启用开关）
4. 打开 Tampermonkey Dashboard，该脚本右侧"匹配"列应该显示 `*://*.pintia.cn/*`

### Q: 面板出现了但 Ctrl+V 还是没反应？

1. 先确认光标在答题框里（点一下编辑器，光标闪起来）
2. 看面板最后几条日志：
   - 绿色 `✓ CM6 API 写入` → 写入成功，但编辑器可能被其他机制回滚
   - 橙色 `逐字符写入...` → 正在模拟键盘，稍等几秒
   - 红色 → 把红色那行完整发出来

### Q: 面板显示"当前页面不是考试/dashboard"？

- 你当前的 URL 不在 `/exam/` 或 `/problem-sets/dashboard` 路径下
- 点 `Alt+Shift+P` 手动重新检测；如果还是不行，检查地址栏的完整 URL

### Q: 怎么卸载？

Tampermonkey → Dashboard → 该脚本 → 删除图标（垃圾桶）。删除后刷新 PTA 页面即恢复原样。

## 📄 License

MIT © qqqw1111
