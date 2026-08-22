import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function assertReleaseTag(tag, version) {
  const actual = String(tag || '').trim()
  const expected = `v${String(version || '').trim()}`
  if (!actual || expected === 'v' || actual !== expected) {
    throw new Error(`release tag ${actual || '(missing)'} does not match package version ${expected}`)
  }
  return expected
}

export function checkReleaseTag({
  tag = process.env.RELEASE_TAG,
  packagePath = resolve(root, 'package.json'),
} = {}) {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  return assertReleaseTag(tag, pkg.version)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const tag = checkReleaseTag()
    console.log(`${tag} matches package.json`)
  } catch (error) {
    console.error(String(error?.message || error))
    process.exitCode = 1
  }
}
