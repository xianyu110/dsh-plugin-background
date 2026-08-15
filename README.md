# dsh-plugin-background

DeepSeek Harness Web 界面的背景插件：为对话区、轨迹区、侧边栏、设置页等界面区域设置独立背景，支持图片轮播与静音视频。灵感来自 VSCode 的 [`background`](https://marketplace.visualstudio.com/items?itemName=shalldie.background) 扩展。

## 它能做什么

- 每个区域一套独立背景：图片组像 PPT 一样轮播切换，视频组静音循环播放（每组只含一种媒体）
- 支持粘贴 URL（逗号分隔多张）、选择本地图片/视频、或整个文件夹；本地文件刷新后保留
- 每张图独立设置：显示模式（填充/适应/拉伸/平铺/居中/自定义）、不透明度、模糊
- 轮播间隔、顺序/随机、下一张；切换前预加载并交叉淡入，不会闪空
- 勾选多个区域后添加，同一批图可一次落到多个区域
- 拖拽两个区域可**合并为一张跨区域大图**（多显示器壁纸效果），拖出即拆分
- 兼容 [dsh-better-sidebar](https://github.com/gameswu/dsh-plugin-vscode-sidebar)：其右侧/底部面板的每个标签页都可作为独立背景区域

## 安装

插件通过 profile 的 pnpm 环境安装（`dsh plugin` 即把 pnpm 参数转发到 profile 目录）：

```bash
# 从本地路径安装（<路径>/background 为本仓库目录）
dsh plugin --profile web add <路径>/background

# 或者从 GitHub 安装
dsh plugin --profile web add github:gameswu/dsh-plugin-background
```

然后在 profile 的补丁层挂载（`$DSH_HOME/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: ui-background
      name: dsh-plugin-background
```

重启 Web 界面（`dsh web`）后生效。

## 使用

打开 **设置 → 插件 → 背景**：

1. 在表面列表中点击要配置的区域（勾选多行可一次添加到多个区域）
2. 粘贴图片/视频链接，或选择本地文件
3. 点击缩略图进入编辑器调整显示模式与参数
4. 把一个区域行**拖到另一个区域行上**，即可合并为跨区域大图

## 更新与开发

```bash
npm install          # 开发依赖：esbuild + typescript
npm run build        # 打包 → lib/client.js
npm run typecheck    # 类型检查
```

重新构建后把 `lib/client.js` 同步到已安装副本，再硬刷新浏览器（Ctrl+Shift+R）即可，无需重启服务。

## License

[MIT](LICENSE)
