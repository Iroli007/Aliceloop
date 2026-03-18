import { CompanionLayout } from "./features/companion/CompanionLayout";
import { useCompanionData } from "./features/companion/useCompanionData";
import { ShellLayout } from "./features/shell/ShellLayout";
import { useShellData } from "./features/shell/useShellData";

export function App() {
  const surface = new URL(window.location.href).searchParams.get("surface");

  if (surface === "companion" || window.location.pathname === "/companion") {
    return <CompanionApp />;
  }

  return <ShellApp />;
}

function ShellApp() {
  const state = useShellData();
  return <ShellLayout state={state} />;
}

function CompanionApp() {
  const state = useCompanionData();
  return <CompanionLayout state={state} />;
}
