import { contextBridge, ipcRenderer } from "electron";
import type { AwBridge, AuthState, BootstrapProgress } from "../shared/types";

const bridge: AwBridge = {
  getState: () => ipcRenderer.invoke("aw:getState"),
  login: (email, password) => ipcRenderer.invoke("aw:login", email, password),
  signup: (email, password) => ipcRenderer.invoke("aw:signup", email, password),
  startEmailCode: (email) => ipcRenderer.invoke("aw:startEmailCode", email),
  verifyEmailCode: (email, code) => ipcRenderer.invoke("aw:verifyEmailCode", email, code),
  startGoogleSignIn: () => ipcRenderer.invoke("aw:startGoogleSignIn"),
  pickWorkspace: (slug) => ipcRenderer.invoke("aw:pickWorkspace", slug),
  listWorkspaces: () => ipcRenderer.invoke("aw:listWorkspaces"),
  preflight: () => ipcRenderer.invoke("aw:preflight"),
  createLocalWorkspace: (name) => ipcRenderer.invoke("aw:createLocalWorkspace", name),
  finishLocalSetup: (slug) => ipcRenderer.invoke("aw:finishLocalSetup", slug),
  removeLocalWorkspace: (slug) => ipcRenderer.invoke("aw:removeLocalWorkspace", slug),
  getBootstrapProgress: () => ipcRenderer.invoke("aw:getBootstrapProgress"),
  onBootstrapProgress: (cb: (p: BootstrapProgress) => void) => {
    const listener = (_event: unknown, next: BootstrapProgress) => cb(next);
    ipcRenderer.on("aw:bootstrap-progress", listener);
    return () => ipcRenderer.removeListener("aw:bootstrap-progress", listener);
  },
  onWorkspaceStatus: (cb: (slug: string) => void) => {
    const listener = (_event: unknown, slug: string) => cb(slug);
    ipcRenderer.on("aw:workspace-status", listener);
    return () => ipcRenderer.removeListener("aw:workspace-status", listener);
  },
  copyDiagnostics: () => ipcRenderer.invoke("aw:copyDiagnostics"),
  logout: () => ipcRenderer.invoke("aw:logout"),
  onStateChanged: (cb: (state: AuthState) => void) => {
    const listener = (_event: unknown, next: AuthState) => cb(next);
    ipcRenderer.on("aw:state-changed", listener);
    return () => ipcRenderer.removeListener("aw:state-changed", listener);
  },
};

contextBridge.exposeInMainWorld("aw", bridge);
