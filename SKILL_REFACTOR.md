# Skills 改造方案

从 Alma 移植过来的 skills 需要改造，去除所有 Alma 特定的痕迹，改造成 Alice 原创功能。

## 需要删除的 Skills

### 1. travel
**原因：** 深度个性化功能，完全为 Alma 设计
- 虚拟旅行系统，包含人格成长、情绪管理
- 依赖 `~/.config/alma/travels/` 和 `alma travel` 命令
- 与 SOUL.md 深度集成
- 无法改造成通用功能

**操作：** 删除 `apps/daemon/src/context/skills/travel/`

---

## 需要改造的 Skills

### 2. skill-search → skill-discovery

**原功能：** 搜索和安装新 skills（依赖 alma skill 命令和 skills.sh 生态）

**改造目标：** Skill 发现和推荐系统

**改造要点：**
- 删除所有 `alma skill` 命令引用
- 改用直接读取 skills 目录的方式
- 功能：列出、搜索、推荐本地已安装的 skills
- 不做"安装"，只做"发现"

**实现方式：**
```bash
# 列出所有 skills
ls -1 apps/daemon/src/context/skills/ | grep -v skillLoader.ts

# 搜索 skill（读取 SKILL.md 的 description）
grep -r "description:" apps/daemon/src/context/skills/*/SKILL.md

# 推荐：根据任务关键词匹配 skill 描述
```

**新的 SKILL.md 结构：**
```markdown
---
name: skill-discovery
description: Discover and recommend available skills when encountering tasks beyond current capabilities.
allowed-tools:
  - Read
  - Glob
---

# Skill Discovery

When you encounter a task you can't handle, search for relevant skills in the local skills directory.

## How It Works

1. List all installed skills by reading the skills directory
2. Read each SKILL.md to get descriptions
3. Match task keywords with skill descriptions
4. Recommend the most relevant skill to use

## When to Use

- You're asked to do something beyond your current capabilities
- A task fails because you lack a specialized skill
- The user asks what capabilities are available
```

---

### 3. selfie → alice-selfie

**原功能：** Alma 的自拍系统（面部一致性、私密相册、NSFW）

**改造目标：** Alice 的自拍功能

**核心挑战：**
- 原系统依赖 `~/.config/alma/selfies/` 相册和 `alma selfie` 命令
- 面部一致性依赖相册中的参考照片
- 包含大量 Alma 特定规则（owner、group chat、私密保护）

**改造要点：**

1. **路径改造**
   - `~/.config/alma/selfies/` → `~/.aliceloop/selfies/`
   - 所有 `alma selfie` 命令需要重新实现

2. **命令重新设计**
   - 不依赖 `alma` CLI，直接用 image generation API
   - 面部一致性方案：使用 image-to-image 或 LoRA 技术
   - 相册管理：简单的文件系统操作

3. **规则简化**
   - 删除 owner/group chat 等 Alma 特定规则
   - 删除或重新设计 NSFW 相关内容（根据 Alice 定位决定）
   - 保留核心：面部一致性 + 相册管理

4. **技术栈选择**
   - 面部一致性：Stable Diffusion + IP-Adapter 或 Flux + LoRA
   - 或使用 Replicate/Fal.ai 等 API 的 face reference 功能
   - 相册：JSON metadata + 图片文件管理

**新的 SKILL.md 结构：**
```markdown
---
name: selfie
description: Take selfies with consistent appearance using face reference. Use when users ask for selfies or self-portraits.
allowed-tools:
  - Bash
  - Read
  - Write
---

# Selfie Skill

Take selfies with face consistency using your selfie album.

## Album Location
`~/.aliceloop/selfies/`

## Taking a Selfie

### With existing album (has reference photos):
Use image generation API with face reference from album

### First selfie (no album yet):
Generate initial selfie with full appearance description, then save to album

## Album Management
- List selfies: read album directory
- Save new selfie: copy to album + update metadata
- Get latest: sort by timestamp
```

---

### 4. music-listener

**原功能：** 音频分析（ffprobe + whisper + 频谱图）

**改造目标：** 通用音频分析工具

**改造要点：**
- 保留核心技术栈（ffprobe, ffmpeg, whisper）
- 删除 Alma 特定的"欣赏"语气和个性化评论
- 改成客观的音频分析报告

**新的 SKILL.md 要点：**
```markdown
---
name: audio-analysis
description: Analyze audio files for metadata, frequency spectrum, and transcription. Use when users share audio/music files.
allowed-tools:
  - Bash
---

# Audio Analysis

Analyze audio files using ffprobe, ffmpeg, and whisper.

## Analysis Steps
1. Extract metadata (duration, bitrate, codec, tags)
2. Generate spectrogram for frequency analysis
3. Transcribe audio content with whisper
4. Provide analysis report
```

---

### 5. video-reader

**原功能：** 视频理解（Gemini API + ffmpeg fallback）

**改造要点：**
- 删除所有 `alma video` 命令
- 改用直接的 API 调用或 bash 命令
- 保留核心逻辑

**新的 SKILL.md 要点：**
```markdown
---
name: video-analysis
description: Analyze video content using AI vision models or frame extraction + transcription.
allowed-tools:
  - Bash
---

# Video Analysis

## Primary: Use AI vision API (Gemini/GPT-4V)
Upload video and analyze with vision model

## Fallback: Frame extraction + Whisper
1. Extract key frames with ffmpeg
2. Transcribe audio with whisper
3. Combine visual and audio analysis
```

---

### 6. twitter-media

**原功能：** Twitter 内容提取（fxtwitter API）

**改造要点：**
- 保留核心技术（fxtwitter API）
- 通用化描述，不提及 Alma

**新的 SKILL.md 要点：**
```markdown
---
name: twitter-media
description: Extract content from Twitter/X links - text, images, videos. Use when users share twitter.com or x.com URLs.
allowed-tools:
  - Bash
  - WebFetch
---

# Twitter Media Extraction

Extract media and text from Twitter/X posts using fxtwitter API.

## API Endpoint
`https://api.fxtwitter.com/{username}/status/{tweet_id}`

## Extracted Content
- Tweet text
- Images (all photos in tweet)
- Videos (with thumbnails)
- Author info
```

---

### 7. xiaohongshu-cli

**原功能：** 小红书操作工具

**改造要点：**
- 保留核心功能（已经是通用工具）
- 删除 Alma 特定的 wrapper 脚本引用
- 改用直接的 `xhs` 命令或 `uvx xiaohongshu-cli`

**新的 SKILL.md 要点：**
```markdown
---
name: xiaohongshu
description: Xiaohongshu/小红书 operations - login, search, read notes, post content, manage account.
allowed-tools:
  - Bash
---

# Xiaohongshu CLI

Use xiaohongshu-cli for all Xiaohongshu operations.

## Installation
```bash
uvx --from xiaohongshu-cli xhs --help
# or
uv tool install xiaohongshu-cli
```

## Common Commands
- Login: `xhs login`
- Search: `xhs search "keyword"`
- Read note: `xhs note <note_id>`
- Post: `xhs post --image <path> --title "title" --content "content"`
```

---

## 实施步骤

### Phase 1: 删除不需要的 skills
```bash
rm -rf apps/daemon/src/context/skills/travel
```

### Phase 2: 改造 skill-search
1. 重命名为 skill-discovery
2. 重写 SKILL.md，删除所有 `alma skill` 命令
3. 改用 Read/Glob 工具读取本地 skills 目录

### Phase 3: 改造 selfie
1. 重写 SKILL.md
2. 改路径：`~/.config/alma/selfies/` → `~/.aliceloop/selfies/`
3. 删除所有 `alma selfie` 命令引用
4. 重新设计面部一致性实现方案
5. 删除 Alma 特定规则（owner、NSFW 等）

### Phase 4: 改造其他 skills
按照上述方案逐个改造：
- music-listener → audio-analysis
- video-reader → video-analysis
- twitter-media（保持名称，改内容）
- xiaohongshu-cli → xiaohongshu

---

## 注意事项

1. **完全去除 Alma 痕迹**
   - 不要出现 `alma` 命令
   - 不要出现 `~/.config/alma/` 路径
   - 不要出现 Alma 特定的规则和术语

2. **保持功能完整性**
   - 核心技术栈保留
   - 功能逻辑保留
   - 只改命令和路径

3. **重写描述和文档**
   - 用 Alice 的视角重写
   - 避免直接复制 Alma 的措辞
   - 让它看起来是原创的

4. **测试验证**
   - 改造后测试每个 skill 是否能正常工作
   - 确保没有遗留的 Alma 引用

