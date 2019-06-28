const TransformCache = require('./transform-cache')
const generateSnapshotScript = require('./generate-snapshot-script')
const createWatcher = require('./watch');

async function initializeCache(options) {
  const cacheInvalidationKey = options.shouldExcludeModule.toString() + require('../package.json').version
  const cache = new TransformCache(options.cachePath, cacheInvalidationKey)
  await cache.loadOrCreate()
  return cache
}

module.exports = async function (options) {
  let cache = null;
  try {
    cache = await initializeCache(options)
    delete options.cachePath
    const result = await generateSnapshotScript(cache, options)
    return result
  } finally {
    if (cache) {
      await cache.dispose()
    }
  }
}

module.exports.createWatcher = async function(options) {
  const cache = await initializeCache(options)
  return await createWatcher(cache, options);
}
