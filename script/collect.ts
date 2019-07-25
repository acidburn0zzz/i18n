#!/usr/bin/env ts-node

if (!process.env.GH_TOKEN || !process.env.CROWDIN_KEY) {
  require('dotenv-safe').load()
}

import * as del from 'del'
import * as fs from 'fs'
import * as got from 'got'
import { sync as mkdir } from 'make-dir'
import * as path from 'path'
import { execSync } from 'child_process'
import * as Octokit from '@octokit/rest'
const packageJson: Record<string, string[]> = require('../package.json')
const electronDocs = require('electron-docs')
const currentEnglishBasepath = path.join(
  __dirname,
  '..',
  'content',
  'current',
  'en-US'
)
const englishBasepath = (version: string) =>
  path.join(__dirname, '..', 'content', version, 'en-US')

const NUM_SUPPORTED_VERSIONS = 4

const github = new Octokit({
  auth: process.env.GH_TOKEN ? process.env.GH_TOKEN : '',
})

interface IResponse {
  tag_name: string
  assets: Octokit.ReposGetReleaseByTagResponseAssetsItem[]
}

interface IElectronDocsResponse {
  slug: string
  filename: string
  markdown_content: string
}

let release: IResponse

main().catch((err: Error) => {
  console.log('Something goes wrong. Error: ', err)
  process.exit(1)
})

async function main() {
  await fetchRelease()
  await getSupportedBranches(release.tag_name)
  await delUnsupportedBranches(packageJson.supportedVersions)
  await delContent(packageJson.supportedVersions)
  await fetchAPIDocsFromLatestStableRelease()
  await fetchAPIDocsFromSupportedVersions()
  await fetchApiData()
  await getMasterBranchCommit()
  await fetchTutorialsFromMasterBranch()
  await fetchTutorialsFromSupportedBranch()
  await fetchWebsiteContent()
}

async function regerenerateCrowdinYAML(versions: Array<string>) {
  const yamlPath = path.join(__dirname, '../crowdin.yml')
  const yamlOriginal = fs.readFileSync(yamlPath, 'utf8')
  const arr: Array<string> = []

  versions.forEach(version => {
    const example = `
  # AUTOMATICALLY GENERATED CONTENT FOR ${version}
  - source: /content/${version}/en-US/docs/*.md
    translation: /content/${version}/%locale%/docs/%original_file_name%
  - source: /content/${version}/en-US/docs/development/*.md
    translation: /content/${version}/%locale%/docs/development/%original_file_name%
  - source: /content/${version}/en-US/docs/tutorial/*.md
    translation: /content/${version}/%locale%/docs/tutorial/%original_file_name%
  - source: /content/${version}/en-US/docs/api/*.md
    translation: /content/${version}/%locale%/docs/api/%original_file_name%
  - source: /content/${version}/en-US/docs/api/structures/*.md
    translation: /content/${version}/%locale%/docs/api/structures/%original_file_name%
`

    const start = '# start autogenerated table'
    const end = '# end autogenerated table'
    const target = new RegExp(`${start}[\\s\\S]*${end}`, 'gm')
    const replacement = `${start}\n${example}${end}`
    arr.push(replacement)
    const yamlNew = yamlOriginal.replace(target, arr as any)

    fs.writeFileSync(yamlPath, yamlNew)
  })
}

/**
 * Removes unsuppored branch folder from content dir.
 */
async function delUnsupportedBranches(versions: Array<string>) {
  const folders = fs.readdirSync('content')
  folders.pop()
  if (folders.length !== versions.length) {
    versions.push('current')
    const difference = folders.filter(x => !versions.includes(x)).toString()
    del(path.join(__dirname, '..', 'content', difference))
    versions.pop()
    regerenerateCrowdinYAML(versions)
  }

  return Promise.resolve()
}

/**
 * Removes base content folder for rewriting.
 */
async function delContent(branches: Array<string>) {
  console.log('Deleting content')

  console.log('  - Deleting current content')
  await del(currentEnglishBasepath)
  for (const branch of branches) {
    console.log(`  - Deleting content for ${branch}`)
    await del(englishBasepath(branch))
  }
}

/**
 * Get the list of supported branches.
 * Returns an `Array<string>` of supported branches and writes into
 * the `package.json` as a `supportedVersions` array.
 * NOTE: Skips the current version.
 */
async function getSupportedBranches(current: string) {
  console.log(`Fetching latest ${NUM_SUPPORTED_VERSIONS} supported versions`)
  // TODO: all fine 🔥?
  const currentVersion = current
    .slice(1, 6)
    .replace(/\./, '-')
    .replace(/\.[0-9]/, '-x')

  const resp = await github.repos.listBranches({
    owner: 'electron',
    repo: 'electron',
  })

  const branches = resp.data
    .filter(branch => {
      return branch.protected && branch.name.match(/[0-9]-[0-9]-x/)
    })
    .map(b => b.name)

  const filtered: Record<string, string> = {}
  branches.sort().forEach(branch => (filtered[branch.charAt(0)] = branch))
  const filteredBranches = Object.values(filtered)
    .slice(-NUM_SUPPORTED_VERSIONS)
    .filter(arr => arr !== currentVersion && arr !== 'current')

  writeToPackageJSON('supportedVersions', filteredBranches)
  return Promise.resolve(
    console.log(
      '  - Successfully written `supportedVersions` into package.json'
    )
  )
}

/**
 * Fetches current electron release and writes into the release let.
 */
async function fetchRelease() {
  console.log(`Determining 'latest' version dist-tag on npm`)
  const version = execSync('npm show electron version')
    .toString()
    .trim()

  console.log(`  - Fetching release data from GitHub`)

  const repo = {
    owner: 'electron',
    repo: 'electron',
    tag: `v${version}`,
  }

  const res = await github.repos.getReleaseByTag(repo)
  release = res.data

  return Promise.resolve(`  - Sucecssfully fetched release ${release.tag_name}`)
}

/**
 * Fetches tutorials from the current branch.
 * Suppored branches downloads in the `fetchAPIDocsFromSupportedVersions()`
 * function.
 */
async function fetchAPIDocsFromLatestStableRelease() {
  console.log(`Fetching API docs from electron/electron#${release.tag_name}`)

  writeToPackageJSON('electronLatestStableTag', release.tag_name)
  const docs = await electronDocs(release.tag_name)

  docs
    .filter((doc: IElectronDocsResponse) => doc.filename.startsWith('api/'))
    .forEach((doc: IElectronDocsResponse) => writeDoc(doc))

  return Promise.resolve(
    console.log(
      ` - Successfully fetched API docs from electron/electron#${release.tag_name}`
    )
  )
}

/**
 * Fetches tutorials from Electron supported branches.
 * Current docs downloads in the `fetchAPIDocsFromLatestStableRelease()`
 * function.
 */
async function fetchAPIDocsFromSupportedVersions() {
  console.log('Fetching API docs from suppored branches')

  for (const version of packageJson.supportedVersions) {
    console.log(`  - from electron/electron#${version}`)
    const docs = await electronDocs(version)

    docs
      .filter((doc: IElectronDocsResponse) => doc.filename.startsWith('api/'))
      .forEach((doc: IElectronDocsResponse) => {
        writeDoc(doc, version)
      })
  }

  return Promise.resolve()
}

/**
 * Fetches `electron-api.json` without changes into the current docs directory.
 */
async function fetchApiData() {
  console.log(
    `Fetching API definitions from electron/electron#${release.tag_name}`
  )

  const asset = release.assets.find(asset => asset.name === 'electron-api.json')

  if (!asset) {
    return Promise.reject(
      Error(`No electron-api.json asset found for ${release.tag_name}`)
    )
  }

  const response = await got(asset.browser_download_url, { json: true })
  const apis = response.body
  const filename = path.join(currentEnglishBasepath, 'electron-api.json')
  mkdir(path.dirname(filename))
  console.log(
    `  - Writing ${path.relative(
      currentEnglishBasepath,
      filename
    )} (without changes)`
  )
  fs.writeFileSync(filename, JSON.stringify(apis, null, 2))
  return Promise.resolve(apis)
}

/**
 * Gets the master branch commit and writes into `package.json` as
 * an `electronMasterBranchCommit` property.
 */
async function getMasterBranchCommit() {
  console.log(`Fetching Electron master branch commit SHA`)
  const master = await github.repos.getBranch({
    owner: 'electron',
    repo: 'electron',
    branch: 'master',
  })

  writeToPackageJSON('electronMasterBranchCommit', master.data.commit.sha)
}

/**
 * Fetches tutorials from the master branch.
 * Suppored branches downloads in the `fetchTutorialsFromSupportedBranch()`
 * function.
 */
async function fetchTutorialsFromMasterBranch() {
  console.log(`Fetching tutorial docs from electron/electron#master`)

  const docs = await electronDocs('master')

  docs
    .filter((doc: IElectronDocsResponse) => !doc.filename.startsWith('api/'))
    .filter((doc: IElectronDocsResponse) => !doc.filename.includes('images/'))
    .forEach((doc: IElectronDocsResponse) => writeDoc(doc))

  return Promise.resolve()
}

/**
 * Fetches tutorials from Electron supported branches.
 * Current docs downloads in the `fetchTutorialsFromMasterBranch()`
 * function.
 */
async function fetchTutorialsFromSupportedBranch() {
  console.log(`Fetching tutorial docs from supported branches`)

  for (const version of packageJson.supportedVersions) {
    console.log(`  - from electron/electron#${version}`)
    const docs = await electronDocs(version)

    docs
      .filter((doc: IElectronDocsResponse) => !doc.filename.startsWith('api/'))
      .filter((doc: IElectronDocsResponse) => !doc.filename.includes('images/'))
      .forEach((doc: IElectronDocsResponse) => {
        writeDoc(doc, version)
      })
  }

  return Promise.resolve()
}

/**
 * Fetches locale.yml from the website repo and saves into
 * the `current` directory.
 */
async function fetchWebsiteContent() {
  console.log(`Fetching locale.yml from electron/electronjs.org#master`)

  const url =
    'https://cdn.jsdelivr.net/gh/electron/electronjs.org@master/data/locale.yml'
  const response = await got(url)
  const content = response.body
  const websiteFile = path.join(currentEnglishBasepath, 'website', `locale.yml`)
  mkdir(path.dirname(websiteFile))
  console.log(
    `  - Writing ${path.relative(currentEnglishBasepath, websiteFile)}`
  )
  fs.writeFileSync(websiteFile, content)
  return Promise.resolve()
}

// Utility functions

function writeDoc(doc: IElectronDocsResponse, version?: string) {
  let basepath = currentEnglishBasepath
  if (version) basepath = englishBasepath(version)
  const filename = path.join(basepath, 'docs', doc.filename)
  mkdir(path.dirname(filename))
  fs.writeFileSync(filename, doc.markdown_content)
  // console.log('   ' + path.relative(englishBasepath, filename))
}

function writeToPackageJSON(key: string, value: string | Array<string>) {
  const pkg = require('../package.json')
  pkg[key] = value
  fs.writeFileSync(
    require.resolve('../package.json'),
    JSON.stringify(pkg, null, 2)
  )
}
