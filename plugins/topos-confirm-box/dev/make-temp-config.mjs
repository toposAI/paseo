#!/usr/bin/env node
/**
 * mock-topos 用の一時設定を /tmp に作る(ダミーの鍵・権限 0600)。本番の設定・鍵には触れない。
 *
 *   node plugins/topos-confirm-box/dev/make-temp-config.mjs [full|old] [--port 18777]
 *
 * 出力された環境変数を Paseo 起動時に渡す:
 *   TOPOS_PROJECTS_CONFIG=/tmp/topos-mock/paseo_projects.json
 */
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2] === "old" ? "old" : "full";
const pi = process.argv.indexOf("--port");
const port = pi > 0 ? Number(process.argv[pi + 1]) || 18777 : 18777;
const dir = "/tmp/topos-mock";
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const tokenFile = path.join(dir, `key-${mode}`);
fs.writeFileSync(tokenFile, mode === "old" ? "mock-old-key\n" : "mock-full-key\n", { mode: 0o600 });
fs.chmodSync(tokenFile, 0o600);

const configFile = path.join(dir, "paseo_projects.json");
fs.writeFileSync(
  configFile,
  JSON.stringify({ login: "me@mock.local", origin: `http://127.0.0.1:${port}`, baseUrl: `http://127.0.0.1:${port}`, tokenFile }, null, 2),
  { mode: 0o600 },
);
fs.chmodSync(configFile, 0o600);
console.log(`TOPOS_PROJECTS_CONFIG=${configFile}   (key: ${mode})`);
