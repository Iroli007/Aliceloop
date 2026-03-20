import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aliceloopDesktop", {
  getAppMeta: () => ipcRenderer.invoke("app:get-meta"),
  pingRuntime: () => ipcRenderer.invoke("runtime:ping"),
  openFileOrFolder: () => ipcRenderer.invoke("dialog:open-file-or-folder"),
});
