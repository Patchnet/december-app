import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReleaseTag } from './check-release-tag.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pause = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

export function expectedReleaseAssets(version) {
  const installer = `December-Setup-${version}-x64.exe`
  return [installer, `${installer}.blockmap`, 'latest.yml']
}

export function assertLatestMetadata(metadata, version) {
  const text = String(metadata || '')
  const declaredVersion = text.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1]
  const installerPath = text.match(/^path:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]
  const expectedInstaller = `December-Setup-${version}-x64.exe`

  if (declaredVersion !== version) {
    throw new Error(`latest.yml version ${declaredVersion || '(missing)'} does not match ${version}`)
  }
  if (installerPath !== expectedInstaller) {
    throw new Error(`latest.yml path ${installerPath || '(missing)'} does not match ${expectedInstaller}`)
  }
  if (!/^sha512:\s*\S+/m.test(text)) {
    throw new Error('latest.yml is missing its installer sha512')
  }
  return { version: declaredVersion, path: installerPath }
}

export async function verifyReleaseAssets({
  tag = process.env.RELEASE_TAG,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  packagePath = resolve(root, 'package.json'),
  fetchImpl = globalThis.fetch,
  attempts = 12,
  delayMs = 5_000,
  sleep = pause,
} = {}) {
  const { version } = JSON.parse(readFileSync(packagePath, 'utf8'))
  const releaseTag = assertReleaseTag(tag, version)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository || ''))) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository pair')
  }
  if (typeof fetchImpl !== 'function') throw new Error('release verification requires fetch')

  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
  const expected = expectedReleaseAssets(version)
  let missing = [...expected]

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/releases/tags/${releaseTag}`,
      { headers },
    )
    if (response.ok) {
      const release = await response.json()
      const assets = new Map((release.assets || []).map((asset) => [asset.name, asset]))
      missing = expected.filter((name) => !assets.has(name))
      if (missing.length === 0) {
        const metadataAsset = assets.get('latest.yml')
        const metadataResponse = await fetchImpl(metadataAsset.browser_download_url, {
          headers: { ...headers, accept: 'application/octet-stream' },
        })
        if (!metadataResponse.ok) {
          throw new Error(`latest.yml download failed with HTTP ${metadataResponse.status}`)
        }
        const metadata = assertLatestMetadata(await metadataResponse.text(), version)
        return { releaseTag, expected, metadata }
      }
    } else if (response.status !== 404) {
      throw new Error(`GitHub release lookup failed with HTTP ${response.status}`)
    }

    if (attempt < attempts) await sleep(delayMs)
  }

  throw new Error(`GitHub release ${releaseTag} is missing required assets: ${missing.join(', ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyReleaseAssets()
    console.log(`${result.releaseTag} publishes ${result.expected.join(', ')}`)
  } catch (error) {
    console.error(String(error?.message || error))
    process.exitCode = 1
  }
}
