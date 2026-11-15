# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

<a id="dsh-web"></a>

## DSH Web

这个 fork 增加了 DSH Web：一个以静态站点形式、完全在浏览器中运行的 harness 版本。智能体、工具和 Session 日志都运行在 Web Worker 中，模型请求由浏览器直接发往 DeepSeek API，所以没有服务器接触你的密钥或文件。DSH Web 是非官方项目：它基于 DeepSeek Harness 构建，与 DeepSeek 没有隶属关系。

- **数据留在浏览器中**：Session、设置和 API 密钥持久保存在源私有文件系统中。可在**设置 → 通用 → 浏览器数据**中备份、恢复和清除。
- **私有工作区**：所有工作区都保存在浏览器的源私有文件系统中，因此 DSH Web 绝不会读写你电脑上的文件夹。首次启动时默认工作区已准备就绪。文件通过附加或分享进入，通过备份导出。
- **支持 bash 语法的 shell**：循环、函数、管道、`grep`、`sed`、`awk`、`jq` 和 `git`，受同一套权限模式约束。没有 `node`、`python` 或包管理器。
- **真正的已安装应用**：可以安装为独立窗口的应用，无网络时也能启动，不过模型仍然需要网络。从其他应用分享的文件和文字会作为新会话的草稿打开，你发送之前不会发出任何内容；会话在后台完成时，它可以发送通知并在图标上显示角标。**设置 → 通用 → 应用**中提供安装、更新、存储保护和通知选项。

```sh
pnpm install
pnpm run build:lib
pnpm --filter @deepseek-ai/dsh-web-frontend run build:site  # writes apps/web/dist-site
```

把 `apps/web/dist-site` 部署到任意 HTTPS 静态托管即可。限制和内部实现见[运行时 README](packages/experimental/webworker-runtime/README.zh.md#known-limitations-and-deferred-work)。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

本分支以 GNU Affero 通用公共许可证第 3 版（AGPL-3.0）发布（[LICENSE](LICENSE)）。它所基于的 DeepSeek Harness 原始代码仍以 MIT 许可证发布（[LICENSE-MIT](LICENSE-MIT)）。

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
