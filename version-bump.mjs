// Picks the next release version and writes it into manifest.json, package.json and versions.json.
// The next version is the patch after the newest tag, unless manifest.json was bumped by hand past it.
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const read = (f) => JSON.parse(readFileSync(f, "utf8"));
const write = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
const parse = (v) => v.split(".").map(Number);
const newer = (a, b) => {
  const i = a.findIndex((n, j) => n !== b[j]);
  return i >= 0 && a[i] > b[i];
};

const manifest = read("manifest.json");
const latest = execSync("git tag --list")
  .toString()
  .split("\n")
  .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
  .map(parse)
  .reduce((max, t) => (!max || newer(t, max) ? t : max), null);

let next = parse(manifest.version);
if (latest && !newer(next, latest)) next = [latest[0], latest[1], latest[2] + 1];
const version = next.join(".");

manifest.version = version;
write("manifest.json", manifest);
const pkg = read("package.json");
pkg.version = version;
write("package.json", pkg);
const lock = read("package-lock.json");
lock.version = lock.packages[""].version = version;
write("package-lock.json", lock);
const versions = read("versions.json");
versions[version] = manifest.minAppVersion;
write("versions.json", versions);

console.log(version);
