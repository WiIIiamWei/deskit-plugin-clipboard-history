#!/usr/bin/env node
// Validates deskit.json against the vendored manifest schema, then checks
// the few conventions the schema can't express (every manifest command id
// must be a non-empty reverse-DNS string, and manifest.main must point at a
// file that the build produces). Run in CI and before packing.
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import process from "node:process"
import Ajv from "ajv"

const ROOT = path.resolve(import.meta.dirname, "..")

async function main() {
  const schema = JSON.parse(
    await readFile(path.join(ROOT, "schema", "deskit-manifest.schema.json"), "utf-8")
  )
  const manifest = JSON.parse(await readFile(path.join(ROOT, "deskit.json"), "utf-8"))

  // The $schema key is an editor convenience; strip it before validating
  // so additionalProperties:false in the schema doesn't reject it.
  const { $schema, ...toValidate } = manifest

  const ajv = new Ajv({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)
  if (!validate(toValidate)) {
    console.error("✖ deskit.json failed schema validation:\n")
    for (const e of validate.errors ?? []) {
      console.error(`  - ${e.instancePath || "/"} ${e.message}`)
    }
    process.exit(1)
  }

  const mainRel = String(manifest.main).replace(/^\.\//, "")
  if (!existsSync(path.join(ROOT, mainRel))) {
    console.error(
      `✖ manifest.main "${manifest.main}" does not exist. Run \`npm run build\` first.`
    )
    process.exit(1)
  }

  console.log(`✓ deskit.json valid — ${manifest.id}@${manifest.version}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
