import { contextBridge, ipcRenderer } from "electron";
import type { AwBridge, AuthState } from "../shared/types";

const bridge: AwBridge = {
  getState: () => ipcRenderer.invoke("aw:getState"),
  login: (email, password) => ipcRenderer.invoke("aw:login", email, password),
  signup: (email, password) => ipcRenderer.invoke("aw:signup", email, password),
  startEmailCode: (email) => ipcRenderer.invoke("aw:startEmailCode", email),
  verifyEmailCode: (email, code) => ipcRenderer.invoke("aw:verifyEmailCode", email, code),
  startGoogleSignIn: () => ipcRenderer.invoke("aw:startGoogleSignIn"),
  pickWorkspace: (slug) => ipcRenderer.invoke("aw:pickWorkspace", slug),
  listWorkspaces: () => ipcRenderer.invoke("aw:listWorkspaces"),
  checkRuntime: () => ipcRenderer.invoke("aw:checkRuntime"),
  createLocalWorkspace: (name) => ipcRenderer.invoke("aw:createLocalWorkspace", name),
  logout: () => ipcRenderer.invoke("aw:logout"),
  onStateChanged: (cb: (state: AuthState) => void) => {
    const listener = (_event: unknown, next: AuthState) => cb(next);
    ipcRenderer.on("aw:state-changed", listener);
    return () => ipcRenderer.removeListener("aw:state-changed", listener);
  },
};

contextBridge.exposeInMainWorld("aw", bridge);
