const crypto = require('crypto')
const levelup = require('levelup')
const encode = require('encoding-down')
const leveldown = require('leveldown')

module.exports = class TransformCache {
  constructor (filePath, invalidationKey) {
    this.filePath = filePath
    this.invalidationKey = invalidationKey
    this.cache = {}
    this.db = null
    this.usedKeys = new Set()
  }

  async loadOrCreate () {
    await this._initialize()
    const oldKey = await this._db_get('invalidation-key')
    const newKey = crypto.createHash('sha1').update(this.invalidationKey).digest('hex')
    if (oldKey !== newKey) {
      await this._db_put('invalidation-key', newKey)
      this.cache = {}
    } else {
      this.cache = await this._db_get('electron-link-cache') || {}
    }
  }

  async persistCacheToDisk () {
    await this._db_put('electron-link-cache', this.cache);
  }

  async dispose () {
    await this.persistCacheToDisk()
    await new Promise((resolve, reject) => {
      this.db.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }

  put ({filePath, original, transformed, requires, map}) {
    const key = crypto.createHash('sha1').update(original).digest('hex')
    const entry = this.cache[filePath] || {}
    entry.source = transformed
    entry.requires = requires
    entry.map = map
    entry.key = key
    this.cache[filePath] = entry
    this.usedKeys.add(filePath)
  }

  get ({filePath, content = null}) {
    if (!this.cache[filePath]) {
      return null
    }

    this.usedKeys.add(filePath)

    const {
      source,
      requires,
      map,
      key
    } = this.cache[filePath];

    let needsInvalidation = false
    if (content !== null) {
      needsInvalidation = key !== crypto.createHash('sha1').update(content).digest('hex')
    }

    if (source && requires && !needsInvalidation) {
      return {source, requires, map}
    } else {
      return null
    }

  }

  async deleteUnusedEntries () {
    const unusedKeys = this._allKeys()
    for (const key of this.usedKeys) {
      unusedKeys.delete(key)
    }

    for (const key of unusedKeys) {
      delete this.cache[key]
    }
  }

  async _initialize () {
    this.db = await new Promise((resolve, reject) => {
      levelup(encode(leveldown(this.filePath), { valueEncoding: 'json' }), {}, (error, db) => {
        if (error) {
          reject({error})
        } else {
          resolve(db)
        }
      })
    })
  }

  _db_put (key, value) {
    return new Promise((resolve, reject) => {
      this.db.put(key, value, {}, (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }

  _db_get (key) {
    return new Promise((resolve, reject) => {
      this.db.get(key, {}, (error, value) => {
        if (error) {
          if (error.notFound) {
            resolve(null)
          } else {
            reject(error)
          }
        } else {
          resolve(value)
        }
      })
    })
  }

  _allKeys () {
    return new Set(Object.keys(this.cache))
  }
}
