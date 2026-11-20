// Usage: node refresh-yml-dmg.js <latest-mac.yml> <dmg>
// Rewrites the sha512/size of the DMG's entry after stapling changed the file.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function refresh(yml, dmgPath) {
  const buf = fs.readFileSync(dmgPath);
  const sha512 = crypto.createHash("sha512").update(buf).digest("base64");
  const name = path.basename(dmgPath);
  const lines = yml.split("\n");
  let hit = false;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-?\s*url:\s*/.test(lines[i]) || !lines[i].includes(name)) continue;
    hit = true;
    for (let j = i + 1; j < lines.length && !/^\s*-\s*url:/.test(lines[j]) && /^\s+\S/.test(lines[j]); j++) {
      if (/^\s+sha512:/.test(lines[j])) lines[j] = lines[j].replace(/sha512:.*/, `sha512: ${sha512}`);
      if (/^\s+size:/.test(lines[j])) lines[j] = lines[j].replace(/size:.*/, `size: ${buf.length}`);
    }
  }
  if (!hit) throw new Error(`no entry for ${name} in latest-mac.yml`);
  return lines.join("\n");
}

module.exports = { refresh };

if (require.main === module) {
  const [ymlPath, dmgPath] = process.argv.slice(2);
  fs.writeFileSync(ymlPath, refresh(fs.readFileSync(ymlPath, "utf8"), dmgPath));
  console.log(`refreshed ${path.basename(dmgPath)} in ${ymlPath}`);
}
