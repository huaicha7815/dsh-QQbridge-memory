# 上游来源与本地修改（vendoring manifest）

本目录 `tools/memory-galaxy/` 是从第三方项目 **vendoring**（复制）进来的前端与布局代码，
不是本仓库原创。记录这份清单是为了：合规（MIT 要求保留版权声明）、可追溯、以及升级时不丢本地补丁。

## 上游

| 项 | 值 |
| --- | --- |
| 项目 | dsh-Memory-Galaxy |
| 仓库 | https://github.com/leesingx/dsh-Memory-Galaxy |
| 许可 | MIT（Copyright (c) 2026 Derpyu520 & 大肥鱼），见同目录 `LICENSE` |
| 导入日期 | 2026-11-01 |
| 导入版本 | `main` 分支（当时无 tag；导入时提交可在上游 `git log` 中按日期定位） |

## 导入的文件

| 文件 | 说明 | 本地是否修改 |
| --- | --- | --- |
| `index.html` | 页面骨架、Canvas 与本地补丁入口 | **是**（见下） |
| `data.js` | 数据布局层（`layout()` / `buildGalaxy()`） | 否 |
| `LICENSE` | 上游 MIT 许可原文 | 否 |
| `app.js` | 从 `index.html` 拆出的前端脚本，接入控制台 token 引导与独立 CSP | **是** |
| `app.css` | 从 `index.html` 拆出的页面样式，供外置 CSS 路由使用 | **是** |

## 本地修改（升级上游时必须重新打上）

1. **核心标签**：`index.html` 的 `draw()` 在核心辉光之后绘制 `meta.coreLabel` / `meta.coreSub`
   （核心恒星代表角色本人，而不是一组钉住记忆的聚合）。
2. **DOM XSS 转义**：`index.html` 增加 `esc()`，并把它用于记忆标题、标签、`data-id`
   （记忆内容来自聊天原文，不可当作可信 HTML）。

## 数据来源替换

上游自带的数据源（meow / 旧 qq-bridge 格式）不用；我们用自己的投影层
`scripts/lib/galaxy-export.mjs`，把 V3 记忆库（events / salient / profile / days·weeks·months /
events-archive）投影成上游 `layout()` 认识的 `{ stars, messages }`。

## 升级流程

1. 拉取上游新版本，替换 `index.html` / `data.js`；
2. 按上面的「本地修改」逐条重打补丁（`git diff` 对比 vendor 目录可确认是否丢失）；
3. 跑 `node scripts/test-galaxy.mjs`（含前端转义断言）；
4. 用 `node scripts/galaxy-preview.mjs` 做一次视觉回归（核心标签、旋臂、遗忘推演）。

## Vendored snapshot

> 本地 vendored 文件内容哈希（用于检测误改/漂移），不是上游 commit SHA；网络恢复后补真 SHA。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `index.html` | 2124 | `c692c61504506a6d1857ff8cbce1f61e1f308f280937a66f7bea4c09b4c600a7` |
| `data.js` | 11770 | `ed54026044a777c645394d2533f4bbd5f0836563bac1cdd8a8fed71cd003e309` |
| `LICENSE` | 1078 | `af54b77be0e83da33f093e0cf6005a5224c5a04b1f8a342f75c74e13f66905db` |
| `app.js` | 30914 | `59b5b36ed6d83e33d6d96a295c0a120594d18da04875b272572920f84db1ba09` |
| `app.css` | 7981 | `c98204b349ab8f6ad4f30f558a33380f5349fdb1330860f9a897c395924b85ef` |

生成方式：

```sh
sha256sum \
  tools/memory-galaxy/index.html \
  tools/memory-galaxy/data.js \
  tools/memory-galaxy/LICENSE \
  tools/memory-galaxy/app.js \
  tools/memory-galaxy/app.css
```

```powershell
Get-FileHash -Algorithm SHA256 -Path @(
  'tools\memory-galaxy\index.html'
  'tools\memory-galaxy\data.js'
  'tools\memory-galaxy\LICENSE'
  'tools\memory-galaxy\app.js'
  'tools\memory-galaxy\app.css'
)
```

- Upstream commit: pending network access
- Local patch: coreLabel/coreSub 绘制、CSP 拆分（将 `index.html` 的内联脚本和样式拆分到 `app.js` / `app.css`，并接入独立 CSP）；详见上方本地补丁清单
