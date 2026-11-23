import { WebContentsView, type BrowserWindow } from "electron";
import { join } from "node:path";
import { bannerHtml, type BannerState, type BannerView } from "./recoveryBanner";

const BANNER_HEIGHT = 40;

/** Non-blocking strip along the top of the workspace window. Hidden = removed, so it never covers the UI. */
export function createBannerView(win: BrowserWindow): BannerView & { dispose(): void; webContentsId(): number } {
  const view = new WebContentsView({
    webPreferences: { preload: join(__dirname, "../preload/banner.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let attached = false;
  const layout = () => {
    const { width } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height: BANNER_HEIGHT });
  };
  win.on("resize", layout);
  return {
    webContentsId: () => view.webContents.id,
    render(state: BannerState) {
      if (win.isDestroyed()) return;
      if (state.kind === "hidden") {
        if (attached) win.contentView.removeChildView(view);
        attached = false;
        return;
      }
      void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bannerHtml(state))}`);
      if (!attached) {
        win.contentView.addChildView(view);
        attached = true;
      }
      layout();
    },
    dispose() {
      win.off("resize", layout);
      if (attached && !win.isDestroyed()) win.contentView.removeChildView(view);
      attached = false;
      if (!view.webContents.isDestroyed()) view.webContents.close();
    },
  };
}
