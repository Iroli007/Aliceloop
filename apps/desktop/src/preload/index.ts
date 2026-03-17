import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aliceloopDesktop", {
  getAppMeta: () => ipcRenderer.invoke("app:get-meta"),
  pingRuntime: () => ipcRenderer.invoke("runtime:ping"),
});

