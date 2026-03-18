# @aliceloop/desktop

Electron 桌面本体。

职责：

- GUI 入口
- 今日状态和任务展示
- artifact 浏览
- 人工暂停、终止和确认
- 未来的本地阅读与工作台体验

开发方式：

- `npm run dev --workspace @aliceloop/desktop`
  启动完整 Electron 桌面，需要本机 Electron 二进制已经安装完成。
- `npm run dev:web --workspace @aliceloop/desktop`
  只启动 renderer 浏览器预览，不依赖 Electron，适合绝大多数前端结构联调。
- `VITE_DAEMON_URL=http://127.0.0.1:3030 npm run dev:web --workspace @aliceloop/desktop`
  指向指定 daemon 地址进行联调。
