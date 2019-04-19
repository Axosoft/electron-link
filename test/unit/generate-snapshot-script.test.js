const assert = require('assert')
const fs = require('fs')
const generateSnapshotScript = require('../../src/generate-snapshot-script')
const Module = require('module')
const path = require('path')
const temp = require('temp').track()
const TransformCache = require('../../src/transform-cache')
const {SourceMapConsumer} = require('source-map')

suite('generateSnapshotScript({baseDirPath, mainPath})', () => {
  let previousRequire

  beforeEach(() => {
    previousRequire = Module.prototype.require

    global.moduleInitialized = false
  })

  afterEach(() => {
    Module.prototype.require = previousRequire
    temp.cleanupSync()
  })

  test('simple integration test', async () => {
    const baseDirPath = __dirname
    const mainPath = path.resolve(baseDirPath, '..', 'fixtures', 'module-1', 'index.js')
    const cachePath = temp.mkdirSync()

    {
      const cache = new TransformCache(cachePath, 'invalidation-key')
      await cache.loadOrCreate()
      const {snapshotScript, includedFilePaths} = await generateSnapshotScript(cache, {
        baseDirPath,
        mainPath,
        shouldExcludeModule: ({requiredModulePath}) => requiredModulePath.endsWith('b.js')
      })
      eval(snapshotScript)
      snapshotResult.setGlobals(global, process, {}, {}, console, require)
      assert(!global.moduleInitialized)
      assert.equal(global.initialize(), 'abx/ybAd')
      assert(global.moduleInitialized)

      assert.deepEqual(Array.from(includedFilePaths), [
        path.resolve(baseDirPath, '../fixtures/module-1/index.js'),
        path.resolve(baseDirPath, '../fixtures/module-1/dir/a.js'),
        path.resolve(baseDirPath, '../fixtures/module-1/dir/c.json'),
        path.resolve(baseDirPath, '../fixtures/module-1/node_modules/a/index.js')
      ])
      assert.equal((await cache._allKeys()).size, 9)
      await cache.dispose()
    }

    {
      const cache = new TransformCache(cachePath, 'invalidation-key')
      await cache.loadOrCreate()
      await cache.put({
        filePath: mainPath,
        original: fs.readFileSync(mainPath, 'utf8'),
        transformed: 'global.initialize = () => "cached"',
        requires: []
      })
      const {snapshotScript, includedFilePaths} = await generateSnapshotScript(cache, {
        baseDirPath,
        mainPath,
        shouldExcludeModule: ({requiredModulePath}) => requiredModulePath.endsWith('b.js')
      })
      eval(snapshotScript)
      snapshotResult.setGlobals(global, process, {}, {}, console, require)
      assert.equal(global.initialize(), 'cached')

      assert.deepEqual(Array.from(includedFilePaths), [
        path.resolve(baseDirPath, '../fixtures/module-1/index.js')
      ])
      assert.equal((await cache._allKeys()).size, 3)
      await cache.dispose()
    }

    {
      const cache = new TransformCache(cachePath, 'a-new-invalidation-key')
      await cache.loadOrCreate()
      const {snapshotScript, includedFilePaths} = await generateSnapshotScript(cache, {
        baseDirPath,
        mainPath,
        shouldExcludeModule: ({requiredModulePath}) => requiredModulePath.endsWith('b.js')
      })
      eval(snapshotScript)
      snapshotResult.setGlobals(global, process, {}, {}, console, require)
      assert.equal(global.initialize(), 'abx/ybAd')

      assert.deepEqual(Array.from(includedFilePaths), [
        path.resolve(baseDirPath, '../fixtures/module-1/index.js'),
        path.resolve(baseDirPath, '../fixtures/module-1/dir/a.js'),
        path.resolve(baseDirPath, '../fixtures/module-1/dir/c.json'),
        path.resolve(baseDirPath, '../fixtures/module-1/node_modules/a/index.js')
      ])
      assert.equal((await cache._allKeys()).size, 9)
      await cache.dispose()
    }

    {
      const cache = new TransformCache(cachePath, 'a-new-invalidation-key')
      await cache.loadOrCreate()
      const {includedFilePaths} = await generateSnapshotScript(cache, {
        baseDirPath,
        mainPath,
        shouldExcludeModule: ({requiredModulePath}) => requiredModulePath.endsWith('b.js')
      })

      assert.deepEqual(Array.from(includedFilePaths), [
        path.resolve(baseDirPath, '../fixtures/module-1/index.js'),
        path.resolve(baseDirPath, '../fixtures/module-1/dir/a.js'),
        path.resolve(baseDirPath, '../fixtures/module-1/dir/c.json'),
        path.resolve(baseDirPath, '../fixtures/module-1/node_modules/a/index.js')
      ])
      await cache.dispose()
    }
  })

  test('cyclic requires', async () => {
    const baseDirPath = __dirname
    const mainPath = path.resolve(baseDirPath, '..', 'fixtures', 'cyclic-require', 'a.js')
    const cachePath = temp.mkdirSync()

    {
      const cache = new TransformCache(cachePath, 'invalidation-key')
      await cache.loadOrCreate()
      const {snapshotScript, includedFilePaths} = await generateSnapshotScript(cache, {
        baseDirPath,
        mainPath,
        shouldExcludeModule: ({requiredModulePath}) => requiredModulePath.endsWith('d.js') || requiredModulePath.endsWith('e.js')
      })
      eval(snapshotScript)
      const cachedRequires = []
      const uncachedRequires = []
      Module.prototype.require = function (module) {
        if (module.includes('babel')) {
          return previousRequire(module)
        } else {
          const absoluteFilePath = Module._resolveFilename(module, this, false)
          const relativeFilePath = path.relative(mainPath, absoluteFilePath)
          let cachedModule = snapshotResult.customRequire.cache[relativeFilePath]
          if (cachedModule) {
            cachedRequires.push(relativeFilePath)
          } else {
            uncachedRequires.push(relativeFilePath)
            cachedModule = {exports: Module._load(module, this, false)}
            snapshotResult.customRequire.cache[relativeFilePath] = cachedModule
          }

          return cachedModule.exports
        }
      }
      snapshotResult.setGlobals(global, process, {}, {}, console, require)
      assert.deepEqual(global.cyclicRequire(), {a: 'a', b: 'b', d: 'd', e: 'e'})
      assert.deepEqual(uncachedRequires, ['../d.js', '../e.js', '../d.js'])
      assert.deepEqual(cachedRequires, ['../e.js'])

      assert.deepEqual(Array.from(includedFilePaths), [
        path.resolve(baseDirPath, '../fixtures/cyclic-require/a.js'),
        path.resolve(baseDirPath, '../fixtures/cyclic-require/b.js'),
        path.resolve(baseDirPath, '../fixtures/cyclic-require/c.js')
      ])
      await cache.dispose()
    }
  })

  test('auxiliary data', async () => {
    const cache = new TransformCache(temp.mkdirSync(), 'invalidation-key')
    await cache.loadOrCreate()
    const auxiliaryData = {
      a: 1,
      b: '2',
      c: [3, 4, 5],
      d: {
        e: 6,
        f: [7],
        g: null,
        h: ''
      }
    }
    const {snapshotScript} = await generateSnapshotScript(cache, {
      baseDirPath: __dirname,
      mainPath: path.resolve(__dirname, '..', 'fixtures', 'module-1', 'index.js'),
      auxiliaryData,
      shouldExcludeModule: () => false
    })
    eval(snapshotScript)
    delete snapshotAuxiliaryData.snapshotSections
    assert.deepEqual(snapshotAuxiliaryData, auxiliaryData)
    await cache.dispose()
  })

  test('process.platform', async () => {
    const baseDirPath = __dirname
    const mainPath = path.resolve(baseDirPath, '..', 'fixtures', 'module-2', 'index.js')
    const cache = new TransformCache(temp.mkdirSync(), 'invalidation-key')
    await cache.loadOrCreate()
    const {snapshotScript} = await generateSnapshotScript(cache, {
      baseDirPath,
      mainPath,
      shouldExcludeModule: () => false
    })
    eval(snapshotScript)
    snapshotResult.setGlobals(global, process, {}, {}, console, require)
    assert.deepEqual(global.module2, {platform: process.platform})
    await cache.dispose()
  })

  test('transpilation on demand', async () => {
    const baseDirPath = __dirname
    const mainPath = path.resolve(baseDirPath, '..', 'fixtures', 'module-1', 'index.js')
    const cachePath = temp.mkdirSync()

    const cache = new TransformCache(cachePath, 'invalidation-key')
    await cache.loadOrCreate()
    const {snapshotScript, includedFilePaths} = await generateSnapshotScript(cache, {
      baseDirPath,
      mainPath,
      shouldExcludeModule: () => false,
      transpile: async ({requiredModulePath}) => {
        if (requiredModulePath.endsWith('b.js')) {
          return "(function () { this.b = '(transpiled yo)' }).call(this)"
        } else {
          return undefined
        }
      }
    })

    eval(snapshotScript)
    snapshotResult.setGlobals(global, process, {}, {}, console, require)
    assert(!global.moduleInitialized)
    assert.equal(global.initialize(), 'a(transpiled yo)x/y(transpiled yo)Ad')
    assert(global.moduleInitialized)

    assert.deepEqual(Array.from(includedFilePaths), [
      path.resolve(baseDirPath, '../fixtures/module-1/index.js'),
      path.resolve(baseDirPath, '../fixtures/module-1/dir/a.js'),
      path.resolve(baseDirPath, '../fixtures/module-1/dir/subdir/b.js'),
      path.resolve(baseDirPath, '../fixtures/module-1/dir/c.json'),
      path.resolve(baseDirPath, '../fixtures/module-1/node_modules/a/index.js')
    ])
    assert.equal((await cache._allKeys()).size, 11)
    await cache.dispose()
  })

  test('row translation', async () => {
    const baseDirPath = __dirname
    const mainPath = path.resolve(baseDirPath, '..', 'fixtures', 'module-1', 'index.js')
    const cache = new TransformCache(temp.mkdirSync(), 'invalidation-key')
    await cache.loadOrCreate()
    const {snapshotScript} = await generateSnapshotScript(cache, {
      baseDirPath,
      mainPath,
      shouldExcludeModule: ({requiredModulePath}) => requiredModulePath.endsWith('b.js')
    })
    eval(snapshotScript)
    snapshotResult.setGlobals(global, process, {}, {}, console, require)

    assert.deepEqual(snapshotResult.translateSnapshotRow(10), {relativePath: '<embedded>', row: 10})
    assert.deepEqual(snapshotResult.translateSnapshotRow(288), {relativePath: '<embedded>', row: 288})
    assert.deepEqual(snapshotResult.translateSnapshotRow(289), {relativePath: '../fixtures/module-1/index.js', row: 0})
    assert.deepEqual(snapshotResult.translateSnapshotRow(302), {relativePath: '../fixtures/module-1/index.js', row: 13})
    assert.deepEqual(snapshotResult.translateSnapshotRow(303), {relativePath: '<embedded>', row: 303})
    assert.deepEqual(snapshotResult.translateSnapshotRow(310), {relativePath: '../fixtures/module-1/dir/a.js', row: 5})
    assert.deepEqual(snapshotResult.translateSnapshotRow(321), {relativePath: '../fixtures/module-1/node_modules/a/index.js', row: 0})
    assert.deepEqual(snapshotResult.translateSnapshotRow(323), {relativePath: '<embedded>', row: 323})

    await cache.dispose()
  })
})
