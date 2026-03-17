export interface ShellNavItem {
  id: string;
  label: string;
  shortLabel: string;
}

export const primaryNav: ShellNavItem[] = [
  { id: "chat", label: "会话", shortLabel: "Chat" },
  { id: "library", label: "图书馆", shortLabel: "Library" },
  { id: "artifacts", label: "Artifacts", shortLabel: "Artifacts" },
  { id: "mission", label: "Mission Control", shortLabel: "Mission" },
  { id: "settings", label: "设置", shortLabel: "Settings" },
];

export const dockNav: ShellNavItem[] = [
  { id: "library", label: "Library", shortLabel: "Li" },
  { id: "artifacts", label: "Artifacts", shortLabel: "Ar" },
  { id: "review", label: "Review", shortLabel: "Rv" },
  { id: "runtime", label: "Runtime", shortLabel: "Rt" },
  { id: "tools", label: "Tools", shortLabel: "Tl" },
  { id: "bridge", label: "Bridge", shortLabel: "Br" },
];

