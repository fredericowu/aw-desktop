import { app, safeStorage } from "electron";
import { AuthStore } from "./authStoreCore";

const store = new AuthStore(() => app.getPath("userData"), () => safeStorage);

export const loadToken = (): string | null => store.load();
export const saveToken = (token: string): void => store.save(token);
export const clearToken = (): void => store.clear();
