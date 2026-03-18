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

export interface ProviderCatalogItem {
  id: string;
  name: string;
  subtitle: string;
  status: "active" | "inactive";
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
  { id: "providers", label: "提供商", shortLabel: "▣" },
  { id: "memory", label: "记忆", shortLabel: "◍" },
  { id: "mcp", label: "MCP 服务器", shortLabel: "⌁" },
  { id: "skills", label: "技能", shortLabel: "⌘" },
];

export const providerCatalog: ProviderCatalogItem[] = [
  { id: "minimax", name: "MiniMax", subtitle: "M2.1 系列，先跑首条真实会话", status: "inactive" },
  { id: "anthropic", name: "Anthropic", subtitle: "Claude series", status: "inactive" },
  { id: "claude-code-acp", name: "Claude Code (ACP)", subtitle: "Coding agent provider", status: "inactive" },
  { id: "openai", name: "OpenAI", subtitle: "GPT-5.2, o3, GPT-4o", status: "inactive" },
  { id: "gemini", name: "Google Gemini", subtitle: "Gemini family", status: "inactive" },
  { id: "deepseek", name: "DeepSeek", subtitle: "Reasoning and coding", status: "inactive" },
  { id: "openrouter", name: "OpenRouter", subtitle: "Aggregated model routing", status: "inactive" },
  { id: "azure-openai", name: "Azure OpenAI", subtitle: "Enterprise OpenAI endpoint", status: "inactive" },
];
