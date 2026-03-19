# @aliceloop/desktop

Electron 桌面本体。

职责：

- GUI 入口
- 会话线程、消息流和 provider 设置
- shell / companion 双视图
- artifact、memory、runtime catalog 浏览
- 通过 snapshot + SSE 消费 daemon 事件流
- 人工暂停、终止和确认入口

开发方式：

- `npm run dev --workspace @aliceloop/desktop`
  启动完整 Electron 桌面，需要本机 Electron 二进制已经安装完成。
- `npm run dev:web --workspace @aliceloop/desktop`
  只启动 renderer 浏览器预览，不依赖 Electron，适合绝大多数前端结构联调。
- `VITE_DAEMON_URL=http://127.0.0.1:3030 npm run dev:web --workspace @aliceloop/desktop`
  指向指定 daemon 地址进行联调。

前端易错项：

- shell 聊天区底部留白不能写死，必须按发送框真实高度和实际遮挡区动态计算；否则长消息、流式补全、窗口尺寸变化时，最后一条消息会被 composer 压住。
- 自动贴底不要在每次布局变化时都强推；只在用户本来就在底部附近，或会话切换、消息新增、可视区缩小时再补滚动到底，否则会抢用户滚动位置。
- 大屏缩小态下，聊天历史左边界要和 composer 左边界共用同一套偏移基准，不能只缩内容宽度不调列偏移，否则视觉上会贴近右侧滚动条或和发送框不对齐。
