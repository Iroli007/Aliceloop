# 桌宠应用 🐱

一个基于 PyQt6 的可爱桌面宠物应用。

## 功能特性

- 🎭 **心情系统**：桌宠有四种心情状态（开心、平静、难过、困倦），会根据互动变化
- 💬 **对话气泡**：随机说话，根据心情显示不同台词
- 🖱️ **鼠标互动**：拖拽移动、点击反馈、双击跳跃
- ✨ **动画效果**：呼吸动画、跳跃动画
- 🎨 **可爱外观**：使用程序生成的卡通形象（支持自定义图片）

## 运行要求

- Python 3.8+
- PyQt6

## 安装依赖

```bash
pip install PyQt6
```

## 运行方式

```bash
python main.py
```

## 项目结构

```
desk_pet/
├── main.py              # 主入口
├── src/                 # 源代码
│   ├── pet_window.py    # 主窗口
│   ├── mood_system.py   # 心情系统
│   ├── speech_bubble.py # 对话气泡
│   └── animation_manager.py # 动画管理
├── resources/           # 资源文件
│   ├── images/          # 图片资源
│   └── audio/           # 音频资源
├── config.json          # 配置文件
└── README.md            # 说明文档
```

## 自定义图片

将图片放入 `resources/images/` 目录，命名如下：
- `pet_idle.png` - 默认状态
- `pet_happy.png` - 开心状态
- `pet_sad.png` - 难过状态
- `pet_sleepy.png` - 困倦状态
- `pet_clicked.png` - 被点击时
- `pet_dragging.png` - 被拖拽时

如果没有提供图片，程序会自动生成简单的卡通形象。

## 互动方式

- **单击并拖拽**：移动桌宠位置
- **双击**：播放跳跃动画，增加心情值
- **等待**：桌宠会随机说话，心情会随时间衰减

## 许可证

MIT License
