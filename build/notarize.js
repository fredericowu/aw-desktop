const { notarize } = require("@electron/notarize");
const path = require("node:path");

/** electron-builder afterSign hook — electron-builder/@electron/notarize
 * via notarytool, the direct-download-app analogue of aw-meta-glasses-2's
 * fastlane/TestFlight notarization (Architect card
 * 4175bf3b-9510-8104-8c21-f5008b4d708b §7, Kanban card
 * 4175bf3b-9510-815a-9208-c71b6ae70c5b point 8). Same credential SHAPE —
 * ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_CONTENT_B64 (decoded to
 * ASC_KEY_PATH by the CI step, same as ios.yml) / APPLE_TEAM_ID — as
 * GitHub Actions secrets, none of which exist yet on this repo.
 *
 * Deliberately a no-op (not an error) when those secrets are absent, so
 * `npm run dist` keeps producing an unsigned, unnotarized local build —
 * see the README for what a first signed release still needs. */
module.exports = async function notarizeHook(context) {
  if (context.electronPlatformName !== "darwin") return;

  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyPath = process.env.ASC_KEY_PATH;

  if (!keyId || !issuerId || !keyPath) {
    console.log("notarize: ASC_KEY_ID/ASC_ISSUER_ID/ASC_KEY_PATH not set — skipping notarization.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`notarize: submitting ${appPath} to notarytool...`);
  await notarize({
    tool: "notarytool",
    appPath,
    appleApiKey: keyPath,
    appleApiKeyId: keyId,
    appleApiIssuer: issuerId,
  });
  console.log("notarize: done.");
};
