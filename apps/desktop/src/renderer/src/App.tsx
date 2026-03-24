import { ShellLayout } from "./features/shell/ShellLayout";
import { useShellData } from "./features/shell/useShellData";

export function App() {
  const state = useShellData();
  return <ShellLayout state={state} />;
}
