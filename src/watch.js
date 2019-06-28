const EventEmitter = require('events')
const minimatch = require('minimatch')
const nsfw = require('nsfw')
const path = require('path')
const R = require('ramda')

const transformAndUpsertCacheForPaths = require('./transform-and-upsert-cache')
const generateSnapshotScript = require('./generate-snapshot-script')

class Watcher extends EventEmitter {
  constructor(cache, options) {
    super()
    this.cache = cache
    this.options = options
    this.watchPaths = options.watchPaths
    this.queue = Promise.resolve()
  }

  _watchFn(events) {
    // Get all non-deleted files that match the globs
    const pathsToRetransform = R.pipe(
      R.filter(event => R.includes(event.action, [nsfw.actions.CREATED, nsfw.actions.RENAMED, nsfw.actions.MODIFIED])),
      R.map(
        event => event.action === nsfw.actions.RENAMED
          ? path.join(event.newDirectory, event.newFile)
          : path.join(event.directory, event.file)
      ),
      R.uniq,
      R.filter(filePath => R.any(glob => minimatch(filePath, glob, {}), this.options.globs))
    )(events)

    // Linking is scheduled on a queue to ensure that we do not process the next events until we done processing the
    // most recent event
    this.queue = this.queue.then(async () => {
      this.emit('linking')
      await transformAndUpsertCacheForPaths(this.cache, this.options, pathsToRetransform)
      const result = await generateSnapshotScript(this.cache, Object.assign({forceUseCache: true}, this.options))

      // We don't necessarily care about `awaiting` here as long as the cache is persisted to disk eventually
      this.cache.persistCacheToDisk()

      this.emit('linked', result)
    })
  }

  async start() {
    this.watchers = await Promise.all(R.map(rootPath => nsfw(rootPath, this._watchFn.bind(this)), this.watchPaths))
    await Promise.all(R.map(watcher => watcher.start(), this.watchers))
    this.emit('start')
  }

  async close() {
    if (this.watchers) {
      const oldWatchers = this.watchers
      this.watchers = null
      await Promise.all(R.map(watcher => watcher.stop(), oldWatchers))
      this.cache.dispose()
      this.emit('end')
    }
  }
}

module.exports = function(cache, options) {
  return new Watcher(cache, options)
}

