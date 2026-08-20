import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { checkProfile } from '../src/checks/profile.ts'
import type { RuntimeCheckResult } from '../src/checks/runtime.ts'
import { createProfileFixture, type ProfileFixture } from './helpers.ts'

const fixtures: ProfileFixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()))
})

async function fixture(): Promise<ProfileFixture> {
  const value = await createProfileFixture()
  fixtures.push(value)
  return value
}

function runtime(installationRoot?: string): RuntimeCheckResult {
  return { findings: [], limitations: [], environment: {}, ...(installationRoot === undefined ? {} : { installationRoot }) }
}

async function profileTree(value: ProfileFixture, name = 'doctor'): Promise<string> {
  const directory = join(value.dshHome, 'profiles', name)
  await value.makeDirectory(directory)
  return directory
}

async function validProfile(value: ProfileFixture, name = 'doctor', bundles: readonly string[] = []): Promise<string> {
  const directory = await profileTree(value, name)
  await value.write(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
  return directory
}

function blockers(result: Awaited<ReturnType<typeof checkProfile>>): readonly { readonly checkId: string, readonly severity: string }[] {
  return result.findings.filter(({ severity }) => severity === 'BLOCKER')
}

function expectBlocker(result: Awaited<ReturnType<typeof checkProfile>>, checkId: string): void {
  expect(blockers(result)).toEqual(expect.arrayContaining([expect.objectContaining({ checkId, severity: 'BLOCKER' })]))
}

describe('checkProfile', () => {
  it('resolves explicit DSH_HOME before copied environment and home fallback', async () => {
    // Would catch a diagnosis silently inspecting a different Harness home than the user requested.
    const value = await fixture()
    const explicit = join(value.root, 'explicit')
    const environment = join(value.root, 'environment')
    await Promise.all([explicit, environment, join(value.homeDir, '.dsh')].map((path) => value.makeDirectory(path)))
    const explicitResult = await checkProfile(value.system, { dshHome: explicit }, runtime())
    const environmentResult = await checkProfile(value.system, {}, runtime())
    const fallbackSystem = { ...value.system, environment: {} }
    const fallbackResult = await checkProfile(fallbackSystem, {}, runtime())

    expect(explicitResult.dshHome).toBe(explicit)
    expect(environmentResult.dshHome).toBe(value.dshHome)
    expect(fallbackResult.dshHome).toBe(join(value.homeDir, '.dsh'))
  })

  it('lists profile directories in deterministic order without selecting one', async () => {
    // Would catch the default command accidentally loading an arbitrary profile.
    const value = await fixture()
    await Promise.all(['zeta', 'Alpha', 'beta'].map((name) => profileTree(value, name)))
    await value.write(join(value.dshHome, 'profiles', 'ignored.txt'), 'not a profile')

    const result = await checkProfile(value.system, {}, runtime())

    expect(result.availableProfiles).toEqual(['Alpha', 'beta', 'zeta'])
    expect(result.profile).toBeUndefined()
    expect(result.profileDirectory).toBeUndefined()
  })

  it('reports malformed profile JSON without executing profile code', async () => {
    // Would catch a syntax failure surfacing as a loader crash or executing a target package to inspect it.
    const value = await fixture()
    const directory = await profileTree(value)
    await value.write(join(directory, 'package.json'), '{')

    const result = await checkProfile(value.system, { profile: 'doctor' }, runtime(value.installationRoot))

    expectBlocker(result, 'profile.manifest.parse')
    expect(value.readPaths.some((path) => path.endsWith('index.js'))).toBe(false)
  })

  it('rejects missing or non-array profile bundle declarations', async () => {
    // Would catch treating an absent or malformed bundle declaration as an empty list.
    for (const bundles of [undefined, 'bundle']) {
      const value = await fixture()
      const directory = await profileTree(value)
      const profile = bundles === undefined ? {} : { bundles }
      await value.write(join(directory, 'package.json'), JSON.stringify({ dsh: { profile } }))

      const result = await checkProfile(value.system, { profile: 'doctor' }, runtime())

      expectBlocker(result, 'profile.bundles.invalid')
    }
  })

  it('accepts scoped bundle packages and rejects unusable package specifiers', async () => {
    // Would catch treating paths as package names or rejecting the scoped npm packages that DSH profiles use.
    const scoped = await fixture()
    await validProfile(scoped, 'doctor', ['@scope/bundle'])
    await scoped.addPackage(scoped.installationRoot, '@scope/bundle', {
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }, { path: 'cordis.patch.yml', source: '[]\n' })
    const scopedResult = await checkProfile(scoped.system, { profile: 'doctor' }, runtime(scoped.installationRoot))
    expect(scopedResult.findings.every(({ severity }) => severity === 'PASS')).toBe(true)

    for (const bundle of ['./bundle', '@scope/', '@scope/bundle\\patch', 'bundle name']) {
      const invalid = await fixture()
      const directory = await profileTree(invalid)
      await invalid.write(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [bundle] } } }))
      expectBlocker(await checkProfile(invalid.system, { profile: 'doctor' }, runtime()), 'profile.bundles.invalid')
    }
  })

  it('rejects an empty or comments-only home or profile patch', async () => {
    // Would catch accepting a patch that cannot supply the required Cordis array.
    for (const [location, source] of [['home', ''], ['profile', '# only comments\n']]) {
      const value = await fixture()
      const directory = await validProfile(value)
      await value.write(join(location === 'home' ? value.dshHome : directory, 'cordis.patch.yml'), source)

      const result = await checkProfile(value.system, { profile: 'doctor' }, runtime())

      expectBlocker(result, 'profile.patch.empty')
    }
  })

  it('rejects an empty YAML document and a non-array patch', async () => {
    // Would catch a syntactically valid but unusable patch being treated as a plugin-free configuration.
    for (const source of ['---\n', 'insert: plugin\n']) {
      const value = await fixture()
      const directory = await validProfile(value)
      await value.write(join(directory, 'cordis.patch.yml'), source)

      const result = await checkProfile(value.system, { profile: 'doctor' }, runtime())

      expectBlocker(result, source === '---\n' ? 'profile.patch.empty' : 'profile.patch.invalid')
    }
  })

  it('reports malformed YAML with only the path and one-based location', async () => {
    // Would catch leaking patch source or parser exception dumps in a shareable report.
    const value = await fixture()
    const directory = await validProfile(value)
    const path = join(directory, 'cordis.patch.yml')
    await value.write(path, 'insert: [unterminated\nsecret: SHOULD-NOT-LEAK\n')

    const result = await checkProfile(value.system, { profile: 'doctor' }, runtime())
    const finding = result.findings.find(({ checkId }) => checkId === 'profile.patch.parse')

    expect(finding).toMatchObject({ checkId: 'profile.patch.parse', severity: 'BLOCKER' })
    expect(finding?.evidence).toEqual([expect.stringMatching(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:\\d+:\\d+$`, 'u'))])
    expect(JSON.stringify(finding)).not.toContain('SHOULD-NOT-LEAK')
    expect(JSON.stringify(finding)).not.toContain('YAMLException')
  })

  it('reports an unresolved bundle manifest or missing declared patch', async () => {
    // Would catch a missing installed bundle being deferred until the target loader imports it.
    const missing = await fixture()
    await validProfile(missing, 'doctor', ['missing-bundle'])
    const missingResult = await checkProfile(missing.system, { profile: 'doctor' }, runtime(missing.installationRoot))
    expectBlocker(missingResult, 'profile.bundle.missing')

    const patch = await fixture()
    await validProfile(patch, 'doctor', ['bundle'])
    await patch.addPackage(patch.installationRoot, 'bundle', { dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    const patchResult = await checkProfile(patch.system, { profile: 'doctor' }, runtime(patch.installationRoot))
    expectBlocker(patchResult, 'profile.bundle.patch-missing')
  })

  it('rejects unreadable bundle manifests and patch paths outside the bundle root', async () => {
    // Would catch a forged bundle manifest redirecting patch reads outside the resolved package.
    const unreadable = await fixture()
    await validProfile(unreadable, 'doctor', ['bundle'])
    const unreadableRoot = await unreadable.addPackage(unreadable.installationRoot, 'bundle', { dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    const unreadableSystem = {
      ...unreadable.system,
      async readText(path: string): Promise<string> {
        if (path === join(unreadableRoot, 'package.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return unreadable.system.readText(path)
      },
    }
    const unreadableResult = await checkProfile(unreadableSystem, { profile: 'doctor' }, runtime(unreadable.installationRoot))
    expectBlocker(unreadableResult, 'profile.bundle.missing')

    const unsafe = await fixture()
    await validProfile(unsafe, 'doctor', ['bundle'])
    await unsafe.addPackage(unsafe.installationRoot, 'bundle', { dsh: { bundle: { patch: '../outside.yml' } } })
    const unsafeResult = await checkProfile(unsafe.system, { profile: 'doctor' }, runtime(unsafe.installationRoot))
    expectBlocker(unsafeResult, 'profile.bundle.patch-missing')

    const absolute = await fixture()
    await validProfile(absolute, 'doctor', ['bundle'])
    await absolute.addPackage(absolute.installationRoot, 'bundle', { dsh: { bundle: { patch: 'C:\\outside.yml' } } })
    const absoluteResult = await checkProfile(absolute.system, { profile: 'doctor' }, runtime(absolute.installationRoot))
    expectBlocker(absoluteResult, 'profile.bundle.patch-missing')
  })

  it('rejects a resolver result outside node_modules and a non-file patch target', async () => {
    // Would catch trusting a resolver result that cannot name the package root or a directory masquerading as a patch.
    const unresolvedRoot = await fixture()
    await validProfile(unresolvedRoot, 'doctor', ['bundle'])
    const outsideResolver = { ...unresolvedRoot.system, resolveModule: () => join(unresolvedRoot.root, 'outside.js') }
    expectBlocker(await checkProfile(outsideResolver, { profile: 'doctor' }, runtime(unresolvedRoot.installationRoot)), 'profile.bundle.missing')

    const wrongPackage = await fixture()
    await validProfile(wrongPackage, 'doctor', ['bundle'])
    const mismatchedResolver = { ...wrongPackage.system, resolveModule: () => join(wrongPackage.root, 'node_modules', 'other', 'index.js') }
    expectBlocker(await checkProfile(mismatchedResolver, { profile: 'doctor' }, runtime(wrongPackage.installationRoot)), 'profile.bundle.missing')

    const directoryPatch = await fixture()
    await validProfile(directoryPatch, 'doctor', ['bundle'])
    await directoryPatch.addPackage(directoryPatch.installationRoot, 'bundle', { dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    const packageRoot = join(directoryPatch.installationRoot, 'node_modules', 'bundle')
    await directoryPatch.makeDirectory(join(packageRoot, 'cordis.patch.yml'))
    expectBlocker(await checkProfile(directoryPatch.system, { profile: 'doctor' }, runtime(directoryPatch.installationRoot)), 'profile.bundle.patch-missing')
  })

  it('rejects a package patch link whose canonical target escapes the package', async () => {
    // Would catch the static doctor parsing arbitrary files outside a bundle through an in-package link.
    const value = await fixture()
    await validProfile(value, 'doctor', ['bundle'])
    const packageRoot = await value.addPackage(value.installationRoot, 'bundle', { dsh: { bundle: { patch: 'patch-link/cordis.patch.yml' } } })
    const outside = join(value.root, 'outside')
    const outsidePatch = join(outside, 'cordis.patch.yml')
    await value.write(outsidePatch, '- insert:\n    - name: outside-plugin\n')
    await value.makeDirectoryLink(outside, join(packageRoot, 'patch-link'))

    const result = await checkProfile(value.system, { profile: 'doctor' }, runtime(value.installationRoot))

    expectBlocker(result, 'profile.bundle.patch-missing')
    expect(value.readPaths).not.toContain(outsidePatch)
  })

  it('rejects a resolved package without a bundle patch declaration', async () => {
    // Would catch treating every resolved package as a DSH bundle.
    const value = await fixture()
    await validProfile(value, 'doctor', ['not-a-bundle'])
    await value.addPackage(value.installationRoot, 'not-a-bundle', {})

    const result = await checkProfile(value.system, { profile: 'doctor' }, runtime(value.installationRoot))

    expectBlocker(result, 'profile.bundle.not-bundle')
  })

  it('reports inserted bare plugin names unresolved from installation before profile anchors', async () => {
    // Would catch a profile that resolves only once Cordis begins importing its plugin graph.
    const value = await fixture()
    const directory = await validProfile(value)
    await value.write(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: missing\n      name: missing-plugin\n')

    const result = await checkProfile(value.system, { profile: 'doctor' }, runtime(value.installationRoot))

    expectBlocker(result, 'profile.plugin.unresolved')
    expect(value.resolveCalls).toContainEqual({ specifier: 'missing-plugin', anchors: [value.installationRoot, directory] })
    expect(value.readPaths.some((path) => path.endsWith('index.js'))).toBe(false)
  })

  it('reports only PASS findings for a valid profile, external bundle, and two patches', async () => {
    // Would catch a healthy composition being diagnosed through package evaluation or unstable anchor order.
    const value = await fixture()
    const directory = await validProfile(value, 'doctor', ['external-bundle'])
    await value.write(join(value.dshHome, 'cordis.patch.yml'), '- insert:\n    - id: home\n      name: installed-plugin\n')
    await value.write(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: profile\n      name: profile-plugin\n')
    await value.addPackage(value.installationRoot, 'external-bundle', {
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }, { path: 'cordis.patch.yml', source: '- insert:\n    - id: bundle\n      name: installed-plugin\n' })
    await value.addPackage(value.installationRoot, 'installed-plugin')
    await value.addPackage(directory, 'profile-plugin')

    const result = await checkProfile(value.system, { profile: 'doctor' }, runtime(value.installationRoot))

    expect(result.findings).not.toHaveLength(0)
    expect(result.findings.every(({ severity }) => severity === 'PASS')).toBe(true)
    expect(result.profile).toBe('doctor')
    expect(result.profileDirectory).toBe(directory)
    expect(value.resolveCalls).toEqual([
      { specifier: 'external-bundle', anchors: [value.installationRoot, directory] },
      { specifier: 'installed-plugin', anchors: [value.installationRoot, directory] },
      { specifier: 'profile-plugin', anchors: [value.installationRoot, directory] },
      { specifier: 'installed-plugin', anchors: [value.installationRoot, directory] },
    ])
    expect(value.readPaths.some((path) => path.endsWith('index.js'))).toBe(false)
  })

  it('contains read failures to the affected profile or patch', async () => {
    // Would catch a single unreadable file aborting all diagnostics or being reported as valid.
    const missingManifest = await fixture()
    await profileTree(missingManifest)
    const manifestResult = await checkProfile(missingManifest.system, { profile: 'doctor' }, runtime())
    expectBlocker(manifestResult, 'profile.manifest.parse')

    const unreadablePatch = await fixture()
    const directory = await validProfile(unreadablePatch)
    const patchPath = join(directory, 'cordis.patch.yml')
    await unreadablePatch.write(patchPath, '- insert: []\n')
    const patchSystem = {
      ...unreadablePatch.system,
      async readText(path: string): Promise<string> {
        if (path === patchPath) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return unreadablePatch.system.readText(path)
      },
    }
    const patchResult = await checkProfile(patchSystem, { profile: 'doctor' }, runtime())
    expectBlocker(patchResult, 'profile.patch.read')
  })

  it('rejects profile manifests without a complete dsh profile object', async () => {
    // Would catch partial JSON being mistaken for a valid profile manifest.
    for (const manifest of [{}, { dsh: null }, { dsh: {} }]) {
      const value = await fixture()
      const directory = await profileTree(value)
      await value.write(join(directory, 'package.json'), JSON.stringify(manifest))
      expectBlocker(await checkProfile(value.system, { profile: 'doctor' }, runtime()), 'profile.bundles.invalid')
    }
  })

  it('reports invalid manifests or bundles alongside existing patch blockers and names', async () => {
    // Would catch manifest validation hiding independent invalid patch and unresolved-plugin startup blockers.
    const malformed = await fixture()
    const malformedDirectory = await profileTree(malformed)
    await malformed.write(join(malformedDirectory, 'package.json'), '{')
    await malformed.write(join(malformedDirectory, 'cordis.patch.yml'), '# no patch entries\n')
    const malformedResult = await checkProfile(malformed.system, { profile: 'doctor' }, runtime())
    expectBlocker(malformedResult, 'profile.manifest.parse')
    expectBlocker(malformedResult, 'profile.patch.empty')

    const invalidBundles = await fixture()
    const invalidDirectory = await profileTree(invalidBundles)
    await invalidBundles.write(join(invalidDirectory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: 'bundle' } } }))
    await invalidBundles.write(join(invalidBundles.dshHome, 'cordis.patch.yml'), 'insert: [unterminated\n')
    await invalidBundles.write(join(invalidDirectory, 'cordis.patch.yml'), '- insert:\n    - id: missing\n      name: missing-plugin\n')
    const invalidBundlesResult = await checkProfile(invalidBundles.system, { profile: 'doctor' }, runtime())
    expectBlocker(invalidBundlesResult, 'profile.bundles.invalid')
    expectBlocker(invalidBundlesResult, 'profile.patch.parse')
    expectBlocker(invalidBundlesResult, 'profile.plugin.unresolved')
  })

  it('retains an explicit limitation when profile enumeration is inaccessible', async () => {
    // Would catch a non-missing directory error being silently represented as an empty profile list.
    const value = await fixture()
    const system = {
      ...value.system,
      async readDir(): Promise<never> { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
    }

    const result = await checkProfile(system, {}, runtime())

    expect(result.availableProfiles).toEqual([])
    expect(result.limitations).toEqual(['The DSH profiles directory could not be listed.'])
  })
})
