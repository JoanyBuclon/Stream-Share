// Chromium's third-party notices: 19.4 MB of HTML that every user would carry on disk forever,
// and that nobody opens from an app directory. It cannot simply be deleted — the BSD/MIT terms
// behind it require the notices to be distributed WITH the binary — so it moves to release/, gets
// uploaded to the GitHub Release next to the installer (docker-publish.yml) and is linked from
// /download. Distributed, just not installed.
//
// Move rather than delete on purpose: if the upload step ever stops finding the file, the release
// job fails loudly instead of quietly shipping a build with no notices at all.
//
// .cjs, and both export shapes, because electron-builder resolves hooks through
// `dynamicImportMaybe` (require or import depending on the file) and then reads `default` —
// package.json says "type": "module", so a plain .js here would be ESM and `module.exports` a
// silent no-op.
const { existsSync } = require('node:fs')
const { rename } = require('node:fs/promises')
const path = require('node:path')

const NOTICES = 'LICENSES.chromium.html'

async function afterPack(context) {
  const src = path.join(context.appOutDir, NOTICES)
  const dest = path.join(context.outDir, NOTICES)
  // Already moved by a previous run against the same unpacked dir — nothing to do.
  if (!existsSync(src)) {
    if (existsSync(dest)) return
    throw new Error(`${NOTICES} found in neither ${context.appOutDir} nor ${context.outDir}`)
  }
  await rename(src, dest)
}

module.exports = afterPack
module.exports.default = afterPack
