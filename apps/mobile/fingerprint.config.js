// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { loadRepoEnv } = require("../../scripts/lib/public-config.ts");

// Expo's fingerprint ignores the app version, so binaries of different majors
// share a runtime version whenever native code is unchanged, and a production
// OTA from main would reach every older store binary. Hashing the major
// version keeps each major's OTAs on its own binaries: a new major reaches
// users only once its store build is promoted.
const appConfig = fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8");
const repoEnv = loadRepoEnv();
const version =
  repoEnv.T3CODE_IOS_VERSION ??
  repoEnv.T3CODE_MOBILE_VERSION ??
  appConfig.match(/^ {2}version: (?:repoEnv\.\w+ \?\? )*"([^"]+)"/m)?.[1];
const majorVersion = version?.match(/^(\d+)\./)?.[1];
if (!majorVersion) {
  throw new Error("fingerprint.config.js could not read the app version from app.config.ts");
}

module.exports = {
  nativeModuleSourceType: "files",
  extraSources: [{ type: "contents", id: "appMajorVersion", contents: majorVersion }],
};
