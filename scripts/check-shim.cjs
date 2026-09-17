// Extracts the injected shim from src/proxy.ts and syntax-checks it as real JS.
// The shim is a template literal with a single ${dirJson} interpolation, so we
// substitute a sample directory before parsing.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "proxy.ts"), "utf8");
const open = "<script>";
const close = "</scr" + "ipt>";
const start = src.indexOf(open);
const end = src.indexOf(close);
if (start < 0 || end < 0) {
  console.error("FAIL: could not locate <script> block in src/proxy.ts");
  process.exit(1);
}
const raw = src.slice(start + open.length, end);
// Substitute the one interpolation with a sample path (quoted JSON string).
const body = raw.replace(/\$\{dirJson\}/g, JSON.stringify("D:/code/CableAdjustment"));

const count = (re) => (body.match(re) || []).length;
const defs = {
  isExternalUrl: count(/function isExternalUrl/g),
  forwardExternal: count(/function forwardExternal/g),
  seedProject: count(/function seedProject/g),
  applyLive: count(/function applyLive/g),
  normalize: count(/function normalize/g),
  boot: count(/function boot/g),
};
console.log("shim bytes:", body.length);
console.log("function defs:", JSON.stringify(defs));
console.log("window.open rewrite:", count(/window\.open = function/g));
console.log("has openExternal marker:", body.includes("opencodeSidebar:openExternal"));
console.log("leftover interpolation:", /\$\{/.test(body));

const tmp = path.join(os.tmpdir(), "oc-shim-check.js");
fs.writeFileSync(tmp, body);

let ok = true;
for (const [name, n] of Object.entries(defs)) {
  if (n !== 1) {
    console.error(`FAIL: ${name} defined ${n} time(s), expected exactly 1`);
    ok = false;
  }
}
if (/\$\{/.test(body)) {
  console.error("FAIL: unresolved template interpolation left in shim");
  ok = false;
}

try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  console.log("syntax: OK");
} catch (err) {
  console.error("FAIL: shim is not valid JavaScript");
  console.error(String(err.stderr || err.message));
  ok = false;
}

if (!ok) process.exit(1);
console.log("shim checks passed");
