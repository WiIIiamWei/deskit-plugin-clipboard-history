#!/usr/bin/env node
// Packs the built plugin into a <id>-<version>.deskit archive (a zip) and
// writes its SHA-256 next to it. The archive layout matches what the DesKit
// host + the marketplace check-deskit.mjs expect:
//   deskit.json        (at the archive root)
//   dist/index.js      (the CJS bundle named by manifest.main)
//   assets/**          (optional, if present)
import { createHash } from "node:crypto"
import { createWriteStream, existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import process from "node:process"
import archiver from "archiver"

const ROOT = path.resolve(import.meta.dirname, "..")
const OUT_DIR = path.join(ROOT, "release")

async function main() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "deskit.json"), "utf-8"))
  const mainRel = String(manifest.main).replace(/^\.\//, "")
  if (!existsSync(path.join(ROOT, mainRel))) {
    console.error(`✖ ${manifest.main} missing — run \`npm run build\` first.`)
    process.exit(1)
  }

  await mkdir(OUT_DIR, { recursive: true })
  const base = `${manifest.id}-${manifest.version}`
  const deskitPath = path.join(OUT_DIR, `${base}.deskit`)

  await zip(deskitPath, (archive) => {
    // deskit.json without the editor-only $schema key.
    const { $schema, ...clean } = manifest
    archive.append(`${JSON.stringify(clean, null, 2)}\n`, { name: "deskit.json" })
    archive.file(path.join(ROOT, mainRel), { name: mainRel })
    if (existsSync(path.join(ROOT, "assets"))) {
      archive.directory(path.join(ROOT, "assets"), "assets")
    }
  })

  const buf = await readFile(deskitPath)
  const sha256 = createHash("sha256").update(buf).digest("hex")
  await writeFile(`${deskitPath}.sha256`, `${sha256}  ${base}.deskit\n`, "utf-8")

  console.log(`✓ packed ${path.relative(ROOT, deskitPath)} (${buf.byteLength} bytes)`)
  console.log(`  sha256: ${sha256}`)
  // Surface the digest for the release workflow to capture.
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `sha256=${sha256}\nasset=${base}.deskit\n`, {
      flag: "a",
    })
  }
}

function zip(outPath, build) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath)
    const archive = archiver("zip", { zlib: { level: 9 } })
    output.on("close", resolve)
    archive.on("error", reject)
    archive.pipe(output)
    build(archive)
    void archive.finalize()
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
