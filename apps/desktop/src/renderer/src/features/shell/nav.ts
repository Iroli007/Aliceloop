export interface ShellNavItem {
  id: string;
  label: string;
  shortLabel: string;
}

export interface SettingsNavItem {
  id: string;
  label: string;
  shortLabel: string;
}

export const primaryNav: ShellNavItem[] = [
  { id: "prompt-apps", label: "管理提示词应用", shortLabel: "≡" },
  { id: "gallery", label: "图库", shortLabel: "▣" },
  { id: "mission-control", label: "Mission Control", shortLabel: "◌" },
  { id: "coding", label: "现场编程", shortLabel: "⌘" },
  { id: "settings", label: "设置", shortLabel: "⚙" },
];

export const dockNav: ShellNavItem[] = [
  { id: "threads", label: "线程", shortLabel: "⟲" },
  { id: "library", label: "图书馆", shortLabel: "⌷" },
  { id: "review", label: "复习", shortLabel: "⊙" },
  { id: "runtime", label: "Runtime", shortLabel: ">" },
  { id: "web", label: "网络", shortLabel: "◎" },
  { id: "bridge", label: "Bridge", shortLabel: "↯" },
];

export const settingsNav: SettingsNavItem[] = [
  { id: "providers", label: "模型网关", shortLabel: "▣" },
  { id: "memory", label: "记忆", shortLabel: "◍" },
  { id: "mcp", label: "MCP 服务器", shortLabel: "⌁" },
  { id: "skills", label: "技能", shortLabel: "⌘" },
];
