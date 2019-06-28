const path = require('path')
const fs = require('fs')
const FileRequireTransform = require('./file-require-transform')

module.exports = async function transformAndUpsertCacheForPaths(cache, options, paths) {
  const queue = [...paths]
  const visited = new Set()

  if (!options.transpile) {
    options.transpile = () => ({ code: null, map: null })
  }

  while (queue.length > 0) {
    const filePath = queue.shift()
    let relativeFilePath = path.relative(options.baseDirPath, filePath).replace(/\\/g, '/')
    if (!relativeFilePath.startsWith('.')) {
      relativeFilePath = './' + relativeFilePath
    }

    if (relativeFilePath.startsWith('./node_modules/')) {
      relativeFilePath = relativeFilePath.replace(/^\.\/node_modules\//, '')
    }

    let originalSource = await new Promise((resolve, reject) => {
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
          reject(err)
        } else {
          resolve(data)
        }
      })
    })

    const cachedTransform = await cache.get({filePath, content: originalSource})
    const sourceMapsShouldBeFlushed = options.withSourceMaps && cachedTransform && cachedTransform.map === null

    const useCachedTransform = cachedTransform && !sourceMapsShouldBeFlushed

    if (useCachedTransform) {
      continue
    }

    const transpiled = await options.transpile({requiredModulePath: filePath})
    const source = transpiled.code || originalSource
    const inputSourceMap = transpiled.map

    let foundRequires = []
    const transform = new FileRequireTransform({
      filePath,
      source,
      inputSourceMap,
      extensions: options.extensions,
      baseDirPath: options.baseDirPath,
      didFindRequire: (unresolvedPath, resolvedPath, relativeModulePath) => {
        if (options.shouldExcludeModule({ requiringModulePath: filePath, requiredModulePath: resolvedPath, relativeModulePath })) {
          return true
        } else {
          foundRequires.push({unresolvedPath, resolvedPath})
          return false
        }
      }
    })

    try {
      const transformation = transform.apply()
      const transformedSource = transformation.code
      const transformedMap = transformation.map
      await cache.put({filePath, original: originalSource, transformed: transformedSource, requires: foundRequires, map: transformedMap})
    } catch (e) {
      console.error(`Unable to transform source code for module ${filePath}.`)
      if (e.index) {
        const before = source.slice(e.index - 100, e.index)
        const after = source.slice(e.index, e.index + 100)
        console.error(`\n${before}==>${after}\n`)
      }
    }

    for (let i = 0; i < foundRequires.length; i++) {
      const {resolvedPath} = foundRequires[i]
      if (!visited.has(resolvedPath)) {
        queue.push(resolvedPath)
      }
    }
  }
}
