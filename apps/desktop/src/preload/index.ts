import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aliceloopDesktop", {
  getAppMeta: () => ipcRenderer.invoke("app:get-meta"),
  pingRuntime: () => ipcRenderer.invoke("runtime:ping"),
  openFileOrFolder: () => ipcRenderer.invoke("dialog:open-file-or-folder"),
  openProjectDirectories: () => ipcRenderer.invoke("dialog:open-project-directories"),
  openPath: (targetPath: string) => ipcRenderer.invoke("path:open", targetPath),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleFullscreenWindow: () => ipcRenderer.invoke("window:toggle-fullscreen"),
  openSettings: () => ipcRenderer.invoke("window:open-settings"),
});
