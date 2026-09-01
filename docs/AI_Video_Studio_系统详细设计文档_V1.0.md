# AI Video Studio — 系统详细设计文档

> 文档版本：V1.0  
> 产品形态：Windows / macOS 本地优先 AI 视频创作工作站  
> 核心技术路线：Tauri + React + Rust + Python AI Engine + FFmpeg + SQLite  
> 数据原则：项目数据、原始素材、生成素材与最终成片全部优先保存在用户本机；仅在调用远程 AI 解析/生成接口时上传任务所需的最小数据。  
> 授权原则：软件必须联网授权后使用，通过云端授权中心验证授权码、设备、套餐、功能权限与 API 额度。  

---

# 1. 文档目的

本文档用于指导 **AI Video Studio** 的产品设计、软件架构、桌面端开发、AI Engine 开发、云端授权中心与 AI Gateway 开发。

本产品目标是将以下不同类型的输入：

- 本地视频文件
- 网络视频地址
- 剧本文件
- 剧本文本
- 一句话创意 / 故事想法
- 后续可扩展：小说、漫画、分镜图、角色参考图、场景参考图

统一转换为可继续生产的影视项目结构，并完成：

1. 剧情分析 / 创作
2. 角色设定
3. 场景设定
4. 分镜脚本
5. 角色图生成
6. 场景图生成
7. 分镜图生成
8. 分镜视频生成
9. AI 质检
10. 时间线合成
11. 本地导出最终视频

系统不是单纯的“视频解析工具”，而是一个完整的：

> **AI Director Studio / AI Video Production Workstation**

---

# 2. 产品核心定位

## 2.1 产品定位

AI Video Studio 是一款安装在 Windows 和 macOS 用户电脑上的本地优先 AI 视频创作软件。

用户可以从以下三种主流程开始创作：

### 模式 A：从视频开始

已有视频：

```text
视频文件 / 视频链接
↓
镜头拆分
↓
对白识别
↓
人物识别
↓
场景识别
↓
剧情重建
↓
分镜重建
↓
角色/场景资产化
↓
重新生成视频
```

适合：

- 短剧拆解
- AI 漫剧拆解
- 广告拆解
- 参考视频分析
- 视频镜头逆向工程

---

### 模式 B：从剧本开始

```text
剧本文件 / 剧本文本
↓
剧本理解
↓
角色抽取
↓
场景抽取
↓
剧情结构化
↓
分镜设计
↓
视觉资产生成
↓
视频生成
```

适合：

- 已有短剧剧本
- 小说改编脚本
- 分场剧本
- 对白稿
- 故事梗概

---

### 模式 C：从创意开始

```text
一句想法
↓
故事开发
↓
剧情大纲
↓
角色
↓
场景
↓
完整剧本
↓
分镜
↓
图片
↓
视频
```

适合：

- AI 漫剧
- 短剧
- 故事短视频
- 广告创意
- IP 试片
- 短视频创作

---

# 3. 核心产品原则

## 3.1 Local-first

以下数据必须默认保存在用户本机：

- 原始视频
- 原始剧本
- 项目数据库
- 抽取音频
- 关键帧
- 代理视频
- 角色设定
- 角色参考图
- 场景设定
- 场景参考图
- 分镜脚本
- 分镜图片
- 分镜视频
- 配音
- 字幕
- BGM
- 时间线
- 最终成片
- Prompt
- 项目设置
- 生成历史

云端不得作为项目主存储。

---

## 3.2 云端最小化

云端只承担：

- 授权验证
- 设备管理
- 套餐功能控制
- API 额度
- AI 请求路由
- 临时生成任务
- 临时上传文件
- 软件更新
- 管理后台

如果某个远程模型需要上传图片或视频：

```text
本地素材
↓
上传必要数据
↓
远程 AI
↓
生成结果
↓
客户端下载
↓
保存到本地
↓
云端临时文件按 TTL 删除
```

---

## 3.3 输入不同，项目模型统一

不管项目来自：

```text
Video
Script
Idea
Novel
Storyboard
```

最终都转换成统一的：

```text
Canonical Project Model
```

后续角色、场景、分镜、图片、视频生成系统只依赖 Canonical Model，不依赖原始输入类型。

---

# 4. 总体技术架构

```text
┌─────────────────────────────────────────────────────────────┐
│                   AI Video Studio Desktop                   │
│                    Windows / macOS                          │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ React + TypeScript UI                                  │ │
│ │                                                         │ │
│ │ 首页 / 创作 / 剧情 / 角色 / 场景 / 分镜 / 图片 / 视频 │ │
│ │ 剪辑 / 导出 / 任务中心 / 设置                          │ │
│ └─────────────────────────┬───────────────────────────────┘ │
│                           │ Tauri IPC                       │
│ ┌─────────────────────────▼───────────────────────────────┐ │
│ │                    Rust Core                            │ │
│ │                                                         │ │
│ │ Project Manager                                         │ │
│ │ File / Asset Manager                                    │ │
│ │ SQLite Repository                                       │ │
│ │ Job Manager                                             │ │
│ │ Python Worker Manager                                   │ │
│ │ FFmpeg Manager                                          │ │
│ │ License Manager                                         │ │
│ │ Secure Storage                                          │ │
│ │ Download / Upload Manager                               │ │
│ │ Update Manager                                          │ │
│ └───────────────┬───────────────────┬─────────────────────┘ │
│                 │ JSON IPC          │ Process               │
│        ┌────────▼────────┐   ┌──────▼────────┐              │
│        │ Python AI Engine│   │ FFmpeg/FFprobe│              │
│        │                 │   │               │              │
│        │ Workflow Engine │   │ Extract       │              │
│        │ Agents          │   │ Transcode     │              │
│        │ CV / ASR        │   │ Merge         │              │
│        │ Prompt Compiler │   │ Audio         │              │
│        │ AI Adapters     │   │ Export        │              │
│        └────────┬────────┘   └───────────────┘              │
│                 │                                           │
│              Local File System + SQLite                     │
└─────────────────┼───────────────────────────────────────────┘
                  │ HTTPS
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                         Cloud                               │
│                                                             │
│ License Center                                              │
│ Session / Device Service                                    │
│ Credit Service                                              │
│ AI Gateway                                                  │
│ Generation Job Service                                      │
│ Temporary Object Storage                                    │
│ Update Service                                              │
│ Admin Console                                               │
└───────────────────┬──────────────────────┬──────────────────┘
                    │                      │
                    ▼                      ▼
                LLM APIs             Image / Video APIs
```

---

# 5. 技术栈

## 5.1 Desktop

```text
Tauri
Rust
React
TypeScript
Vite
Tailwind CSS
shadcn/ui
Zustand
TanStack Query
```

---

## 5.2 Python AI Engine

```text
Python
Pydantic
HTTPX
OpenCV
PySceneDetect
NumPy
Pillow
PyMuPDF
python-docx
可选：
PyTorch
ONNX Runtime
Whisper / FunASR
YOLO
CLIP
```

原则：

> 大模型优先调用远程 API，本地 Python 负责预处理、Workflow、Agent、解析、CV 与轻量 AI。

---

## 5.3 本地视频处理

```text
FFmpeg
FFprobe
```

用于：

- 视频元数据
- 音频抽取
- 关键帧
- 视频切割
- 编码
- 代理视频
- 字幕烧录
- BGM 混音
- 音量调整
- 最终导出

---

## 5.4 Local Database

```text
SQLite
WAL Mode
```

---

## 5.5 Cloud

```text
Python
FastAPI
Pydantic
SQLAlchemy
PostgreSQL
Redis
Dramatiq / Celery
S3 / R2 / OSS
Docker
Nginx / Caddy
```

---

# 6. 三层语言职责

## 6.1 React

React 只负责 UI 和交互：

- 页面
- 表单
- 播放器
- 数据展示
- 编辑操作
- 用户确认
- 任务进度
- Timeline
- 设置

React 不负责：

- 授权算法
- FFmpeg 调用
- Python 进程
- API Key
- 敏感 Token
- 文件系统核心操作
- 数据库写入策略

---

## 6.2 Rust

Rust 负责系统能力：

- 本地项目
- 文件路径
- SQLite
- 安全存储
- 授权
- 设备身份
- 任务状态
- Python Worker 生命周期
- FFmpeg 生命周期
- 上传
- 下载
- 失败恢复
- 自动升级

Rust 是 Desktop 的可信边界。

---

## 6.3 Python

Python 负责 AI：

- 输入理解
- 视频分析
- 剧本解析
- 创意扩写
- Story Agent
- Character Agent
- Scene Agent
- Storyboard Agent
- Prompt Compiler
- Model Adapter
- QC
- 视频内容分析
- CV / ASR
- 结构化 JSON 输出

---

# 7. 新建项目流程

新建项目页面：

```text
┌──────────────────────────────────────────────┐
│               创建新项目                    │
│                                              │
│  从哪里开始？                                │
│                                              │
│  [视频文件]     [视频链接]                   │
│                                              │
│  [上传剧本]     [一个想法]                   │
│                                              │
│  后续：小说 / 分镜 / 漫画                    │
└──────────────────────────────────────────────┘
```

同时要求填写 Creation Spec。

---

# 8. Creation Spec

```json
{
  "project_name": "demo",
  "input_type": "IDEA",
  "target_duration": 60,
  "aspect_ratio": "9:16",
  "content_type": "SHORT_DRAMA",
  "visual_style": "ANIME_CINEMATIC",
  "target_platform": "WECHAT_VIDEO_CHANNEL",
  "language": "zh-CN",
  "creation_mode": "DIRECTOR"
}
```

---

## 8.1 creation_mode

### QUICK

AI 自动生成全部内容。

### DIRECTOR

每个重要阶段由用户确认：

```text
剧情
↓
角色
↓
场景
↓
分镜
↓
生成
```

### PROFESSIONAL

允许用户控制：

- Story Beats
- Character Bible
- 场景空间结构
- Shot 参数
- Prompt
- 模型
- Seed
- Reference
- Timeline

---

# 9. 输入工作流

# 9.1 FROM_VIDEO

```text
Video Input
↓
Metadata
↓
Proxy Video
↓
Audio Extraction
↓
Shot Detection
↓
Keyframe Extraction
↓
ASR
↓
Visual Analysis
↓
Timeline Alignment
↓
Character Extraction
↓
Scene Extraction
↓
Story Reconstruction
↓
Storyboard Reconstruction
↓
Canonical Model
```

---

## 9.2 视频 URL

流程：

```text
URL
↓
URL Resolver
↓
判断：
直链？
平台页面？
需要外部下载器？
↓
本地下载
↓
后续等同本地视频
```

注意：

软件应只支持合法可访问、用户有权处理的视频。

---

# 10. FROM_SCRIPT

支持：

```text
TXT
MD
DOCX
PDF
直接粘贴文本
```

---

## 10.1 本地文本解析

TXT / MD：

```text
UTF-8 / 编码识别
```

DOCX：

```text
python-docx
```

PDF：

```text
PyMuPDF
```

扫描 PDF：

```text
OCR / Vision
```

---

## 10.2 Script Type Detection

Python 首先判断：

```text
SCREENPLAY
NOVEL
STORY_OUTLINE
DIALOGUE_SCRIPT
SHOT_SCRIPT
UNKNOWN
```

不同输入使用不同解析模板。

---

## 10.3 Script Workflow

```text
Script
↓
Normalize
↓
Structure Detection
↓
Story Beats
↓
Character Extraction
↓
Scene Extraction
↓
Dialogue Extraction
↓
Scene Sequence
↓
Shot Planning
↓
Canonical Model
```

---

# 11. FROM_IDEA

例如：

```text
一个外卖员获得孙悟空能力，每天只能变身一个小时。
```

Idea Workflow：

```text
Idea
↓
Concept Expansion
↓
World Building
↓
Main Conflict
↓
Character Design
↓
Story Structure
↓
Scene Design
↓
Screenplay
↓
Storyboard
↓
Canonical Model
```

---

# 12. Canonical Project Model

这是系统核心数据模型。

```text
PROJECT
│
├── SOURCE
│
├── CREATION_SPEC
│
├── STORY
│
├── CHARACTERS
│
├── SCENES
│
├── SEQUENCES
│
├── SHOTS
│
├── ASSETS
│
├── JOBS
└── TIMELINE
```

---

# 13. Story Model

```json
{
  "title": "",
  "logline": "",
  "genre": [],
  "theme": "",
  "synopsis": "",
  "tone": "",
  "beats": [
    {
      "id": "BEAT_001",
      "type": "HOOK",
      "description": ""
    }
  ]
}
```

常用 Beat：

```text
HOOK
SETUP
INCITING_INCIDENT
CONFLICT
ESCALATION
REVERSAL
CLIMAX
RESOLUTION
ENDING_HOOK
```

---

# 14. Character Model

```json
{
  "id": "CHAR_001",
  "name": "角色名称",
  "role": "PROTAGONIST",
  "gender": "",
  "age_range": "",
  "appearance": {
    "face": "",
    "hair": "",
    "body": "",
    "clothes": "",
    "accessories": ""
  },
  "personality": "",
  "motivation": "",
  "voice": "",
  "story_function": "",
  "locked": false,
  "reference_assets": []
}
```

---

# 15. Character Lock

用户可以：

```text
🔒 锁定角色
```

锁定后 AI 不得自动修改：

- 脸
- 发型
- 年龄
- 服装
- 配饰
- 身份
- 声线

Story 更新时，已有锁定角色只能引用，不能重写。

---

# 16. Scene Model

```json
{
  "id": "SCENE_001",
  "name": "便利店",
  "location_type": "INTERIOR",
  "time_of_day": "NIGHT",
  "description": "",
  "lighting": "",
  "layout": "",
  "props": [],
  "mood": "",
  "locked": false,
  "reference_assets": []
}
```

---

# 17. Scene Lock

锁定后：

- 空间结构不得改变
- 门窗位置不得改变
- 柜台位置不得改变
- 主色调不得改变
- 灯光不得随机改变

分镜生成必须引用 Scene ID。

---

# 18. Sequence Model

用于表示场次。

```json
{
  "id": "SEQ_001",
  "scene_id": "SCENE_001",
  "order": 1,
  "summary": "",
  "character_ids": [],
  "shot_ids": []
}
```

---

# 19. Shot Model

```json
{
  "id": "A-001",
  "sequence_id": "SEQ_001",
  "scene_id": "SCENE_001",
  "character_ids": ["CHAR_001"],
  "duration": 4.0,
  "shot_size": "MEDIUM",
  "camera_angle": "EYE_LEVEL",
  "camera_movement": "SLOW_PUSH_IN",
  "visual": "",
  "action": "",
  "emotion": "",
  "dialogue": "",
  "sound": "",
  "image_prompt": "",
  "video_prompt": "",
  "negative_prompt": "",
  "status": "DRAFT",
  "locked": false
}
```

---

# 20. Shot 标准字段

每一个镜头至少包含：

- 镜头编号
- 时长
- 场景
- 出镜角色
- 画面
- 景别
- 机位
- 运镜
- 动作
- 表情
- 台词
- 环境音
- 音效
- 图片 Prompt
- 视频 Prompt
- Negative Prompt

---

# 21. 本地项目目录

```text
MyProject/
│
├── project.json
├── project.db
│
├── source/
│   ├── original.mp4
│   ├── original.docx
│   └── original.txt
│
├── derived/
│   ├── audio/
│   ├── frames/
│   ├── shots/
│   ├── proxy/
│   └── transcripts/
│
├── characters/
│   ├── CHAR_001/
│   │   ├── front.png
│   │   ├── side.png
│   │   ├── back.png
│   │   ├── face.png
│   │   └── expressions/
│
├── scenes/
│   ├── SCENE_001/
│   │   ├── master.png
│   │   ├── angle_01.png
│   │   └── angle_02.png
│
├── storyboard/
│   ├── A-001.png
│   ├── A-002.png
│   └── ...
│
├── generated/
│   ├── images/
│   ├── videos/
│   ├── audio/
│   └── subtitles/
│
├── timeline/
│
├── exports/
│   └── final.mp4
│
├── cache/
└── temp/
```

---

# 22. SQLite 设计原则

数据库只保存结构化数据和相对文件路径。

不要将：

- 图片 BLOB
- 视频 BLOB
- 大音频

放进数据库。

---

# 23. 主要 SQLite 表

```text
projects
project_sources
creation_specs

stories
story_beats

characters
character_assets

scenes
scene_assets

sequences
shots
shot_characters
shot_assets

prompts

jobs
job_events
generation_tasks

timeline_tracks
timeline_items

settings
project_versions
```

---

# 24. projects

```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_path TEXT NOT NULL,
    input_type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

# 25. project_sources

```sql
CREATE TABLE project_sources (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_path TEXT,
    source_url TEXT,
    source_text TEXT,
    created_at TEXT NOT NULL
);
```

source_type：

```text
VIDEO_FILE
VIDEO_URL
SCRIPT_FILE
SCRIPT_TEXT
IDEA
```

---

# 26. characters

```sql
CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    data_json TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

# 27. scenes

```sql
CREATE TABLE scenes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

# 28. shots

```sql
CREATE TABLE shots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    sequence_id TEXT,
    scene_id TEXT,
    shot_order INTEGER NOT NULL,
    duration REAL NOT NULL,
    data_json TEXT NOT NULL,
    status TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

# 29. jobs

```sql
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    stage TEXT,
    payload_json TEXT,
    result_json TEXT,
    error_json TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    remote_job_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);
```

---

# 30. Job 类型

```text
IMPORT_VIDEO
DOWNLOAD_VIDEO
ANALYZE_VIDEO

IMPORT_SCRIPT
ANALYZE_SCRIPT

DEVELOP_IDEA

GENERATE_CHARACTER
GENERATE_CHARACTER_ASSET

GENERATE_SCENE
GENERATE_SCENE_ASSET

GENERATE_STORYBOARD
GENERATE_STORYBOARD_IMAGE

GENERATE_SHOT_VIDEO
QC_SHOT_VIDEO

GENERATE_VOICE
GENERATE_SUBTITLE

EXPORT_VIDEO
```

---

# 31. Job 状态机

```text
PENDING
↓
PREPARING
↓
RUNNING
↓
UPLOADING
↓
REMOTE_PROCESSING
↓
DOWNLOADING
↓
POST_PROCESSING
↓
QC
↓
COMPLETED
```

异常：

```text
FAILED
CANCELLED
PAUSED
WAITING_NETWORK
WAITING_CREDIT
WAITING_LICENSE
```

---

# 32. 任务恢复

软件重启时：

```text
扫描 jobs
↓
找到非终态任务
↓
判断本地/远程状态
↓
恢复
```

处理规则：

### 本地任务

RUNNING 且 Worker 已不存在：

```text
→ PENDING
→ 重试
```

### Remote Job

有 remote_job_id：

```text
查询 Gateway
↓
REMOTE_PROCESSING
SUCCESS
FAILED
```

SUCCESS：

```text
继续下载
```

---

# 33. Python Worker 设计

正式版本 Python 不要求用户安装。

Python Engine 打包为 Sidecar：

Windows：

```text
ai-worker.exe
```

macOS：

```text
ai-worker
```

由 Tauri 启动。

---

# 34. Rust ↔ Python IPC

推荐：

```text
stdin/stdout
JSON Lines Protocol
```

每一行一个 JSON。

---

# 35. 请求协议

```json
{
  "version": "1.0",
  "id": "req_001",
  "type": "request",
  "method": "workflow.analyze_video",
  "params": {
    "project_id": "P001",
    "video_path": "D:/project/source/original.mp4"
  }
}
```

---

# 36. Progress Event

```json
{
  "version": "1.0",
  "id": "req_001",
  "type": "progress",
  "progress": 0.42,
  "stage": "character_analysis",
  "message": "正在识别角色"
}
```

---

# 37. Result

```json
{
  "version": "1.0",
  "id": "req_001",
  "type": "result",
  "success": true,
  "data": {}
}
```

---

# 38. Error

```json
{
  "version": "1.0",
  "id": "req_001",
  "type": "error",
  "error": {
    "code": "AI_GATEWAY_TIMEOUT",
    "message": "远程模型请求超时",
    "retryable": true
  }
}
```

---

# 39. Python Engine 项目结构

```text
python-engine/

├── main.py
│
├── core/
│   ├── engine.py
│   ├── protocol.py
│   ├── events.py
│   ├── context.py
│   └── exceptions.py
│
├── inputs/
│   ├── video_input.py
│   ├── script_input.py
│   └── idea_input.py
│
├── agents/
│   ├── input_router.py
│   ├── video_agent.py
│   ├── script_agent.py
│   ├── story_agent.py
│   ├── character_agent.py
│   ├── scene_agent.py
│   ├── storyboard_agent.py
│   ├── prompt_agent.py
│   └── qc_agent.py
│
├── workflows/
│   ├── from_video.py
│   ├── from_script.py
│   ├── from_idea.py
│   ├── generate_characters.py
│   ├── generate_scenes.py
│   ├── generate_storyboard.py
│   ├── generate_shot_video.py
│   └── qc_video.py
│
├── video/
│   ├── scene_detector.py
│   ├── keyframes.py
│   ├── metadata.py
│   └── tracking.py
│
├── audio/
│   ├── asr.py
│   ├── diarization.py
│   └── alignment.py
│
├── vision/
│   ├── character_detection.py
│   ├── face_matching.py
│   ├── scene_analysis.py
│   └── similarity.py
│
├── llm/
│   ├── gateway.py
│   ├── schemas.py
│   └── parser.py
│
├── providers/
│   ├── llm/
│   ├── image/
│   └── video/
│
└── prompts/
```

---

# 40. Agent 体系

Agent 不建议做成多个独立进程。

采用：

```text
一个 Python Worker
+
多个 Agent Module
+
Workflow Engine
```

---

# 41. Input Router

负责判断：

```text
VIDEO
SCRIPT
IDEA
```

并进入不同 Workflow。

---

# 42. Video Agent

负责：

- 镜头理解
- 人物出现位置
- 场景变化
- 画面动作
- 镜头语言
- 关键剧情信息

---

# 43. Script Agent

负责：

- 文本类型
- 场次
- 角色
- 对白
- 动作
- 场景
- 剧情结构

---

# 44. Story Agent

负责：

- Logline
- Story Summary
- Story Beats
- 节奏
- 冲突
- 反转
- 高潮
- Ending Hook

---

# 45. Character Agent

负责：

- 角色抽取
- Character Bible
- 外貌
- 服装
- 性格
- 声线
- 角色关系
- 视觉 Prompt

---

# 46. Scene Agent

负责：

- 场景抽取
- 场景布局
- 灯光
- 道具
- 风格
- 场景图 Prompt

---

# 47. Storyboard Agent

负责：

- Scene → Shot
- 镜头时长
- 景别
- 摄影机
- 运镜
- 人物动作
- 台词
- 音效
- 节奏

---

# 48. Prompt Agent / Prompt Compiler

Prompt Compiler 不只是 LLM 写 Prompt。

应该将：

```text
Global Style
+
Character Bible
+
Character Reference
+
Scene Bible
+
Scene Reference
+
Shot
+
Model Profile
```

编译为最终模型 Prompt。

---

# 49. Model Profile

不同模型使用不同 Prompt Template。

```text
KlingProfile
VeoProfile
SeedanceProfile
SoraProfile
CustomProfile
```

---

# 50. Prompt Compiler 示例

```text
SHOT A-003

STYLE:
cinematic anime...

CHARACTER:
CHAR_001

SCENE:
SCENE_002

CAMERA:
medium close up

ACTION:
...

REFERENCE:
character_front.png
scene_master.png
storyboard/A-003.png
```

编译：

```text
↓
Model-specific Prompt
```

---

# 51. QC Agent

视频生成后：

```text
Generated Video
↓
QC Agent
```

检查：

- 人物数量
- 人物身份
- 脸部一致性
- 服装
- 场景
- 动作
- 镜头
- 画面畸变
- 多手
- 缺手
- 字幕乱码
- 时长
- 台词
- 口型
- 连贯性

---

# 52. QC Score

```json
{
  "character_consistency": 91,
  "scene_consistency": 94,
  "action_accuracy": 82,
  "camera_accuracy": 88,
  "artifact_score": 90,
  "overall": 89
}
```

规则：

```text
overall >= 85 → PASS

70~84 → REVIEW

<70 → RETRY
```

阈值允许配置。

---

# 53. Retry Strategy

生成失败后不要完全重复相同 Prompt。

QC 返回：

```json
{
  "problems": [
    "角色服装错误",
    "镜头过近"
  ],
  "suggested_prompt_patch": "..."
}
```

Prompt Agent：

```text
Original Prompt
+
QC Feedback
↓
Retry Prompt
```

---

# 54. Rust 项目结构

```text
src-tauri/src/

├── main.rs
├── lib.rs
│
├── commands/
│   ├── project.rs
│   ├── story.rs
│   ├── character.rs
│   ├── scene.rs
│   ├── shot.rs
│   ├── generation.rs
│   ├── license.rs
│   └── system.rs
│
├── project/
│   ├── manager.rs
│   ├── paths.rs
│   └── assets.rs
│
├── worker/
│   ├── python.rs
│   ├── protocol.rs
│   └── manager.rs
│
├── jobs/
│   ├── queue.rs
│   ├── job.rs
│   ├── state.rs
│   └── recovery.rs
│
├── ffmpeg/
│   ├── process.rs
│   ├── probe.rs
│   └── export.rs
│
├── auth/
│   ├── license.rs
│   ├── device.rs
│   ├── session.rs
│   └── secure_store.rs
│
├── api/
│   ├── client.rs
│   ├── upload.rs
│   └── download.rs
│
└── database/
    ├── connection.rs
    ├── migrations.rs
    └── repositories/
```

---

# 55. React 项目结构

```text
desktop/src/

├── app/
│
├── pages/
│   ├── HomePage
│   ├── CreateProjectPage
│   ├── ProjectPage
│   ├── SettingsPage
│   └── LicensePage
│
├── features/
│   ├── source/
│   ├── story/
│   ├── characters/
│   ├── scenes/
│   ├── storyboard/
│   ├── images/
│   ├── videos/
│   ├── timeline/
│   ├── export/
│   └── jobs/
│
├── components/
├── hooks/
├── services/
├── stores/
└── types/
```

---

# 56. 主导航

```text
01 创作
02 剧情
03 角色
04 场景
05 分镜
06 图片
07 视频
08 剪辑
09 导出
```

辅助导航：

```text
任务中心
素材库
设置
账户 / 授权
```

---

# 57. 剧情页面

左侧：

```text
故事概要
世界观
剧情大纲
Story Beats
```

右侧：

```text
AI建议
冲突指数
节奏建议
```

操作：

```text
编辑
重新生成
锁定
版本对比
```

---

# 58. 角色页面

卡片：

```text
CHAR_001

[角色图]

姓名
身份
外观
服装
声线

[生成设定图]
[编辑]
[锁定]
```

生成角色资产：

```text
正面
侧面
背面
面部特写
表情
服装
```

---

# 59. 场景页面

```text
SCENE_001

[场景主图]

描述
布局
灯光
道具
时间

[重新生成]
[多角度]
[锁定]
```

---

# 60. 分镜页面

核心页面建议采用：

```text
左：Shot List
中：Storyboard Canvas / Preview
右：Shot Inspector
```

Shot Inspector：

- 时长
- 角色
- 场景
- 景别
- Camera
- Action
- Dialogue
- Sound
- Prompt

---

# 61. Storyboard Card

```text
A-003        4.0s

[Storyboard Image]

角色：林小凡
场景：街道
景别：中景
运镜：推进

画面：
...

台词：
...

[编辑]
[生成图片]
[生成视频]
```

---

# 62. 图片页面

查看：

```text
Character Assets
Scene Assets
Storyboard Images
Other Assets
```

支持：

```text
重新生成
采用
淘汰
设为参考图
锁定
删除
```

---

# 63. 视频页面

```text
A-001 ✅
A-002 ✅
A-003 Generating...
A-004 Queued
A-005 Failed
```

操作：

```text
预览
重新生成
查看Prompt
查看QC
加入时间线
```

---

# 64. Timeline

V1：

```text
V3 Subtitle
V2 FX
V1 Video
```

Audio：

```text
A3 BGM
A2 SFX
A1 Voice
```

第一版不需要实现专业 NLE 的全部功能。

必须支持：

- 排列镜头
- 调整顺序
- Trim
- Fade
- 字幕
- BGM
- 音量
- 导出

---

# 65. FFmpeg 流程

## 导入视频

```text
ffprobe
↓
metadata
```

---

## 代理视频

```text
Original
↓
720p Proxy
```

UI 播放优先 Proxy。

---

## 最终导出

```text
Shot Videos
+
Voice
+
SFX
+
BGM
+
Subtitle
↓
FFmpeg
↓
Final.mp4
```

---

# 66. 授权系统

软件必须联网授权使用。

---

# 67. 激活

首次启动：

```text
输入授权码
↓
生成 Installation ID
↓
生成 Device Key Pair
↓
收集辅助 Fingerprint
↓
POST /license/activate
```

---

# 68. 授权中心验证

检查：

```text
License Exists
License Status
Expiration
Plan
Max Devices
Device Binding
App Version
Ban
```

---

# 69. 返回

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "license_certificate": "...",
  "plan": "PRO",
  "features": [],
  "expires_at": ""
}
```

---

# 70. Device Identity

不建议只使用：

```text
CPU ID
MAC
Disk Serial
```

建议：

```text
Installation ID
+
Device Public Key
+
Hardware Fingerprint
```

Hardware Fingerprint 只作为辅助风险因子。

---

# 71. Secure Storage

Windows：

```text
DPAPI / Windows Credential
```

macOS：

```text
Keychain
```

保存：

- Refresh Token
- Device Private Key
- License Certificate

禁止明文保存敏感 Token。

---

# 72. Session

启动时：

```text
License Certificate
↓
Challenge
↓
Device Signature
↓
Session Token
```

Session Token：

- 短有效期
- 可自动刷新
- 绑定 Device
- 绑定 License
- 绑定 Scope

---

# 73. Scope

示例：

```text
license.basic

ai.analysis
ai.image
ai.video

credits.read

update.read
```

---

# 74. Heartbeat

软件运行时定期：

```text
POST /session/heartbeat
```

不要每次按钮点击都重新验证 License。

---

# 75. 云端 License 数据库

主要表：

```text
users
licenses
license_devices
license_sessions
plans
plan_features
credits
credit_transactions
api_usage
app_versions
bans
audit_logs
```

---

# 76. AI Gateway

Desktop 不直接携带供应商 API Key。

```text
Desktop
↓
Your AI Gateway
↓
OpenAI / Kimi / Image API / Video API
```

---

# 77. Gateway 责任

- Session 验证
- License 验证
- Feature 验证
- Credit 验证
- Rate Limit
- Provider Route
- Usage Log
- Cost
- Temporary Upload
- Remote Job Polling
- Result URL

---

# 78. Provider Adapter

```text
LLMProvider
├── GPTProvider
├── KimiProvider
├── GeminiProvider
└── CustomProvider

ImageProvider
├── ProviderA
├── ProviderB
└── CustomProvider

VideoProvider
├── KlingProvider
├── VeoProvider
├── SeedanceProvider
└── CustomProvider
```

客户端不依赖具体供应商。

---

# 79. Remote Generation API

创建任务：

```http
POST /v1/generation/video
```

返回：

```json
{
  "job_id": "remote_001",
  "status": "QUEUED"
}
```

客户端：

```http
GET /v1/generation/video/remote_001
```

---

# 80. 临时文件

远程任务如果需要：

- storyboard image
- character reference
- scene reference
- source video chunk

上传 Temporary Storage。

对象应带：

```text
TTL
project_session_id
job_id
```

任务完成后清理。

---

# 81. Credits

额度必须由服务端记录。

例如：

```text
ANALYZE_VIDEO = X credits
GENERATE_IMAGE = Y credits
GENERATE_VIDEO = Z credits
```

数据库保留真实货币成本和用户 Credit 成本。

---

# 82. 本地不能保存“可信余额”

UI 可以缓存显示：

```text
remaining_credits
```

但真正扣费判断必须由 Cloud 完成。

---

# 83. 网络异常

软件必须区分：

```text
Internet Offline
License Server Unavailable
AI Provider Error
Timeout
Rate Limit
Credit Insufficient
```

不同错误有不同 UI。

---

# 84. 数据隐私说明

产品隐私文案应准确描述：

> 项目工程、原始文件、图片、视频和最终成片默认保存在用户本机。使用远程 AI 能力时，完成该次任务所必需的内容可能会临时发送至服务端或第三方模型提供方进行处理。

禁止宣传：

> 所有内容绝不离开电脑

因为远程 AI 调用与该说法冲突。

---

# 85. 自动更新

Cloud：

```text
latest_version
minimum_version
force_update
download_url
signature
```

客户端：

```text
Check Update
↓
Download
↓
Verify Signature
↓
Install
```

---

# 86. Windows 发布

建议：

```text
NSIS / MSI
```

需要：

- Code Signing
- Installer
- Auto Update
- FFmpeg
- Python Sidecar

---

# 87. macOS 发布

```text
.app
.dmg
```

需要：

- Apple Developer Signing
- Hardened Runtime
- Notarization
- Universal / Intel / Apple Silicon 构建策略

---

# 88. Python 打包

开发：

```text
python main.py
```

正式：

```text
PyInstaller / Nuitka
```

目标：

```text
Windows worker.exe

macOS Intel worker

macOS Apple Silicon worker
```

用户无需安装 Python。

---

# 89. Python Engine 依赖控制

V1 不建议直接把大型模型全部内置：

- Torch
- Whisper Large
- YOLO Heavy
- Transformer 大模型

否则：

- 安装包大
- 打包复杂
- GPU 环境复杂

优先：

```text
远程 AI
+
本地轻量预处理
```

---

# 90. Local AI Pack

未来可以增加可选包：

```text
Base App

+ ASR Pack
+ Vision Pack
+ Offline Pack
```

用户按需下载。

---

# 91. 安全原则

## Desktop

- 不保存 Provider API Key
- Refresh Token 安全存储
- HTTPS
- Device Key Pair
- Signed License Certificate
- Python Worker 不持有长期授权凭据

---

## Server

- API Key 存储在 Secrets
- Rate Limit
- Audit Log
- Provider Key Rotation
- Credit Transaction
- License Ban

---

# 92. 防破解现实原则

不能保证桌面软件完全不可破解。

目标：

```text
即使 UI 被破解
↓
核心收费 AI API 仍受 Server 控制
```

因此真正价值资源：

- API Key
- Credits
- AI Gateway
- License State

全部放在云端。

---

# 93. 项目版本

建议项目内容支持 Revision。

例如：

```text
Story V1
Story V2

Character V1
Character V2

Shot A-001 V3
```

避免 AI 重写导致用户无法恢复。

---

# 94. Undo / History

V1 最少支持：

- 文本编辑历史
- AI 重生成历史
- 图片版本
- 视频版本

---

# 95. Asset Model

所有素材都有：

```json
{
  "asset_id": "ASSET_001",
  "asset_type": "CHARACTER_IMAGE",
  "owner_type": "CHARACTER",
  "owner_id": "CHAR_001",
  "path": "characters/CHAR_001/front.png",
  "status": "ACTIVE",
  "created_by_job": "JOB_001"
}
```

---

# 96. 资产版本

重新生成角色图：

```text
front_v1.png
front_v2.png
front_v3.png
```

数据库只有一个：

```text
active_asset_id
```

---

# 97. Reference System

生成 Shot 时输入：

```text
CharacterRef
SceneRef
StyleRef
StoryboardRef
```

统一存储 Asset ID。

不要把文件路径硬编码到 Prompt 数据。

---

# 98. Prompt Storage

每次生成保存：

```text
original_prompt
compiled_prompt
negative_prompt
model
model_version
parameters
references
created_at
```

便于复现。

---

# 99. 生成请求可追溯

Shot Video：

```text
A-001
↓
Prompt V3
↓
Character Asset V2
↓
Scene Asset V1
↓
Storyboard Image V4
↓
Video Job
↓
video_v5.mp4
```

所有链路可追溯。

---

# 100. 项目 Repository 建议

```text
ai-video-studio/

├── apps/
│   ├── desktop/
│   │   ├── src/
│   │   └── src-tauri/
│   │
│   ├── server/
│   │
│   └── admin/
│
├── python-engine/
│
├── packages/
│   ├── schemas/
│   ├── prompts/
│   ├── api-contracts/
│   └── model-profiles/
│
├── binaries/
│   ├── ffmpeg/
│   └── python-worker/
│
├── scripts/
│
├── docs/
│
└── tests/
```

---

# 101. Shared Schema

React / Rust / Python / Server 的对象名称必须统一。

推荐用 JSON Schema / OpenAPI 定义。

核心 DTO：

```text
ProjectDTO
StoryDTO
CharacterDTO
SceneDTO
ShotDTO
JobDTO
AssetDTO
LicenseDTO
GenerationDTO
```

---

# 102. API Version

所有 Cloud API：

```text
/v1/
```

IPC Protocol：

```text
version: 1.0
```

避免未来升级无法兼容。

---

# 103. 日志

本地：

```text
logs/app.log
logs/worker.log
logs/ffmpeg.log
```

日志不要保存：

- Provider Key
- Refresh Token
- 用户完整敏感输入

---

# 104. 崩溃诊断

可选：

```text
Sentry
```

但必须注意隐私。

默认上传：

- Stack Trace
- App Version
- OS
- Error Code

不上传用户视频和项目内容。

---

# 105. 测试

## React

- Component Test
- Store Test
- Critical Flow E2E

## Rust

- Repository
- Job State Machine
- IPC Parser
- License

## Python

- Workflow Unit Test
- Prompt Parser
- Agent Schema
- Video Analysis

## Cloud

- License
- Credit
- Gateway
- Generation

---

# 106. Golden Test

针对 Agent 输出建立固定测试集：

```text
Video A
Script B
Idea C
```

每次 Prompt / Model 改动跑一遍。

检查：

- 角色数
- 场景数
- Shot 结构
- JSON Schema
- Story Quality

---

# 107. MVP 范围

## V0.1 桌面骨架

- Tauri
- React
- 新建项目
- SQLite
- 本地项目目录
- Python Worker
- IPC
- FFmpeg

---

# 108. V0.2 输入

支持：

- 视频文件
- 剧本文本
- 剧本文件
- Idea

视频 URL 可以随后增加。

---

# 109. V0.3 Canonical Model

完成：

- Story
- Character
- Scene
- Sequence
- Shot

UI 可以编辑。

---

# 110. V0.4 AI Analysis

```text
Video → Canonical
Script → Canonical
Idea → Canonical
```

---

# 111. V0.5 Asset Generation

- Character Image
- Scene Image
- Storyboard Image

---

# 112. V0.6 Video Generation

- Shot Generate
- Remote Job
- Download
- Retry
- Job Queue

---

# 113. V0.7 QC

- Shot Video Analysis
- Score
- Retry Prompt

---

# 114. V0.8 Timeline / Export

- Shot Order
- Basic Trim
- Subtitle
- BGM
- FFmpeg Export

---

# 115. V0.9 License

- License Activation
- Device Binding
- Session
- Credit

---

# 116. V1.0

完整商业版：

- Windows
- macOS
- Installer
- Auto Update
- Admin
- License
- Credit
- AI Gateway
- Job Recovery
- Crash Recovery

---

# 117. 第一阶段不建议做

- 专业 Premiere 级剪辑
- 大型本地模型
- 本地视频生成
- 多人实时协作
- 云端项目同步
- 插件商城
- 复杂支付系统
- 大型素材市场

---

# 118. 第一阶段优先解决的问题

## P0

1. 项目结构
2. Canonical Model
3. IPC
4. Job State Machine
5. AI Workflow
6. Character / Scene 一致性
7. 生成任务恢复

---

## P1

1. Prompt Compiler
2. QC
3. Timeline
4. License
5. Credit

---

# 119. 关键技术风险

## 风险 1：视频分析成本

应：

- 本地切镜
- 抽关键帧
- 音频转录
- 只发送必要数据

---

## 风险 2：角色一致性

应：

- Character Bible
- Reference Assets
- Lock
- Prompt Compiler
- QC

---

## 风险 3：场景漂移

应：

- Scene Bible
- Scene Reference
- Layout
- Lock
- Multi-angle Asset

---

## 风险 4：远程视频生成不稳定

应：

- Job Queue
- Retry
- Provider Adapter
- QC
- User Review

---

## 风险 5：桌面任务中断

应：

- SQLite Jobs
- Durable State
- Remote Job ID
- Resume

---

## 风险 6：授权被绕过

不能只靠客户端。

应：

```text
License
+
Server Session
+
Gateway Credit Validation
```

---

# 120. 产品真正的护城河

不是接某个模型 API。

核心应该建立在：

## 1. Video → Canonical Project

准确把视频转成：

- Story
- Character
- Scene
- Shot

---

## 2. Script / Idea → Canonical Project

让不同输入使用同一个生产流程。

---

## 3. Character Memory

角色资产 + Lock + Reference。

---

## 4. Scene Memory

场景空间 + Reference + Lock。

---

## 5. Prompt Compiler

同一份项目数据适配不同 AI 模型。

---

## 6. AI QC

自动发现：

- 人物错误
- 场景错误
- 动作错误
- 画面异常

---

## 7. Durable Workflow

50 个镜头可以：

```text
成功
失败
重试
暂停
继续
```

而不是一次性黑盒执行。

---

# 121. 推荐的最终系统数据流

```text
                   USER INPUT
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
       VIDEO         SCRIPT          IDEA
         │             │             │
         ▼             ▼             ▼
   VideoWorkflow ScriptWorkflow IdeaWorkflow
         └─────────────┼─────────────┘
                       ▼
             CANONICAL PROJECT
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
        STORY      CHARACTERS      SCENES
          └────────────┼────────────┘
                       ▼
                  STORYBOARD
                       ▼
                PROMPT COMPILER
                       ▼
               IMAGE GENERATION
                       ▼
               VIDEO GENERATION
                       ▼
                    AI QC
                       ▼
                   TIMELINE
                       ▼
                    EXPORT
```

---

# 122. Desktop 数据流

```text
React
↓
Tauri Command
↓
Rust
↓
Job Manager
↓
Python Worker / FFmpeg / Cloud
↓
Result
↓
Rust Repository
↓
SQLite / Files
↓
Tauri Event
↓
React
```

---

# 123. 推荐开发顺序

真正开始编码时，推荐严格按以下顺序：

### Step 1

创建 Mono Repo。

### Step 2

Tauri + React 基础应用。

### Step 3

Project Manager。

### Step 4

SQLite Migration。

### Step 5

Python Worker + IPC。

### Step 6

Job Manager。

### Step 7

实现 FROM_IDEA。

原因：

> Idea 输入最简单，可以最快验证 Canonical Model。

### Step 8

实现 FROM_SCRIPT。

### Step 9

实现 FROM_VIDEO。

### Step 10

角色 / 场景 / 分镜 UI。

### Step 11

Image Adapter。

### Step 12

Video Adapter。

### Step 13

Timeline / Export。

### Step 14

License / Credit / AI Gateway。

### Step 15

Windows / macOS 打包。

---

# 124. 为什么优先 FROM_IDEA

如果一开始直接做复杂视频分析，会同时遇到：

- FFmpeg
- Shot Detection
- ASR
- Vision
- Alignment
- LLM
- UI

开发复杂度非常高。

先做：

```text
Idea
↓
Canonical Model
↓
Character
↓
Scene
↓
Storyboard
```

可以最快验证整个产品核心数据模型。

只要 Canonical Model 稳定：

```text
Script
Video
Novel
```

都只是不同的 Input Adapter。

---

# 125. 推荐第一个可运行 Demo

输入：

```text
一个外卖员获得孙悟空能力，每天只能变身一个小时。
```

系统输出：

```text
Story
↓
5 Characters
↓
6 Scenes
↓
20 Shots
```

用户可以编辑。

然后：

```text
生成 Character Images
↓
生成 Scene Images
↓
生成 Storyboard Images
↓
生成前 3 个 Shot Video
↓
合成 Demo.mp4
```

如果这条链跑通，产品核心技术路线就成立。

---

# 126. 开发验收标准

V1 至少达到：

## Project

- 项目可以创建
- 可以关闭
- 可以重新打开
- 数据不丢失

## Input

- Video
- Script
- Idea

## Canonical

- Story
- Characters
- Scenes
- Shots

全部可编辑。

## Asset

- 图片下载本地
- 视频下载本地

## Job

- 支持暂停
- 失败
- 重试
- 软件重启恢复

## License

- 未授权不能进入核心功能
- 设备绑定
- 在线验证

## Export

- 所有镜头可以本地生成完整 MP4。

---

# 127. 最终推荐架构结论

本项目正式采用：

```text
Tauri + React
    ↓
桌面产品壳

Rust
    ↓
系统能力 / 安全 / 文件 / DB / Task

Python
    ↓
AI Engine / Agent / Workflow / CV

FFmpeg
    ↓
本地视频处理

SQLite
    ↓
Local Project Database

FastAPI + PostgreSQL + Redis
    ↓
License / AI Gateway / Credits / Update
```

输入层：

```text
VIDEO
SCRIPT
IDEA
```

统一汇入：

```text
CANONICAL PROJECT MODEL
```

生产层：

```text
STORY
↓
CHARACTER
↓
SCENE
↓
SHOT
↓
IMAGE
↓
VIDEO
↓
QC
↓
TIMELINE
↓
FINAL VIDEO
```

这套设计应作为 AI Video Studio 第一版正式开发基线。

---

# 128. 下一份建议继续输出的技术文档

完成本总体详细设计后，后续建议继续拆成以下独立技术文档：

1. `01-Canonical-Project-Model.md`
2. `02-SQLite-Database-Design.md`
3. `03-Rust-Python-IPC-Protocol.md`
4. `04-Job-Workflow-State-Machine.md`
5. `05-Python-Agent-Engine-Design.md`
6. `06-License-Center-Design.md`
7. `07-AI-Gateway-API-Design.md`
8. `08-React-UI-UX-Spec.md`
9. `09-FFmpeg-Timeline-Export-Design.md`
10. `10-Windows-Mac-Build-Release.md`

这十份文档完成后，就可以直接进入工程初始化、任务拆分和编码阶段。
