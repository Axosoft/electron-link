'use strict'

const fs = require('fs')
const path = require('path')
const FileRequireTransform = require('./file-require-transform')
const {SourceMapGenerator} = require('source-map')
const resolveModulePath = require('./resolve-module-path')

module.exports = async function (cache, options) {
  // Phase 1: Starting at the main module, traverse all requires, transforming
  // all module references to paths relative to the base directory path and
  // collecting abstract syntax trees for use in generating the script in
  // phase 2.
  const moduleASTs = {}
  const moduleSourceMaps = {}
  const requiredModulePaths = [options.mainPath, ...(options.entryPoints || [])]
  const includedFilePaths = new Set(requiredModulePaths)

  if (!options.transpile) {
    options.transpile = () => ({ code: null, map: null })
  }

  while (requiredModulePaths.length > 0) {
    const filePath = requiredModulePaths.shift()
    let relativeFilePath = path.relative(options.baseDirPath, filePath).replace(/\\/g, '/')
    if (!relativeFilePath.startsWith('.')) {
      relativeFilePath = './' + relativeFilePath
    }

    if (relativeFilePath.startsWith('./node_modules/')) {
      relativeFilePath = relativeFilePath.replace(/^\.\/node_modules\//, '')
    }

    if (!moduleASTs[relativeFilePath]) {
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
      const useCachedTransform =
        cachedTransform
          ? cachedTransform.requires.every(
            r => (resolveModulePath({ filePath, extensions: options.extensions, moduleName: r.unresolvedPath }) || r.unresolvedPath) === r.resolvedPath
          )
          : false

      let source
      let map = null
      if(useCachedTransform) {
        source = cachedTransform.source
      } else {
        const transpiled = await options.transpile({requiredModulePath: filePath})
        source = transpiled.code || originalSource
        map = transpiled.map
      }

      let foundRequires = []
      const transform = new FileRequireTransform({
        filePath,
        source,
        map,
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

      let transformedSource, requires, transformedMap
      if (useCachedTransform) {
        transformedSource = cachedTransform.source
        foundRequires = cachedTransform.requires
        transformedMap = cachedTransform.map
      } else {
        try {
          const transformation = transform.apply()
          transformedSource = transformation.code
          transformedMap = transformation.map
        } catch (e) {
          console.error(`Unable to transform source code for module ${filePath}.`)
          if (e.index) {
            const before = source.slice(e.index - 100, e.index)
            const after = source.slice(e.index, e.index + 100)
            console.error(`\n${before}==>${after}\n`)
          }
          throw e
        }
        await cache.put({filePath, original: originalSource, transformed: transformedSource, requires: foundRequires, map: transformedMap})
      }

      const inlineMapURL = transformedMap
        ? getSourceMappingURL(transformedMap)
        : ''

      moduleASTs[relativeFilePath] = transformedSource
      moduleSourceMaps[relativeFilePath] = inlineMapURL

      for (let i = 0; i < foundRequires.length; i++) {
        const {resolvedPath} = foundRequires[i]
        requiredModulePaths.push(resolvedPath)
        includedFilePaths.add(resolvedPath)
      }
    }
  }

  await cache.deleteUnusedEntries()

  const snapshotScript = generateSnapshotScript({
    options,
    moduleASTs,
    moduleSourceMaps,
    withSourceMaps: false
  })

  let snapshotScriptWithSourceMaps = null
  if (options.withSourceMaps) {
    snapshotScriptWithSourceMaps = generateSnapshotScript({
      options,
      moduleASTs,
      moduleSourceMaps,
      withSourceMaps: true
    })
  }

  return { snapshotScriptWithSourceMaps, snapshotScript, includedFilePaths }
}

function generateSnapshotScript({ options, moduleASTs, moduleSourceMaps, withSourceMaps }) {
  // Phase 2: Now use the data we gathered during phase 1 to build a snapshot
  // script based on `./blueprint.js`.
  let snapshotScript = fs.readFileSync(path.join(__dirname, 'blueprint.js'), 'utf8')

  // Replace `require(main)` with a require of the relativized main module path.
  let relativeFilePath = path.relative(options.baseDirPath, options.mainPath).replace(/\\/g, '/')
  if (!relativeFilePath.startsWith('.')) {
    relativeFilePath = './' + relativeFilePath
  }
  snapshotScript = snapshotScript.replace('mainModuleRequirePath', JSON.stringify(relativeFilePath))

  // Assign the current platform to `process.platform` so that it can be used
  // even while creating the snapshot.
  snapshotScript = snapshotScript.replace('processPlatform', process.platform)

  // Assign the current platform's path separator so that custom require works
  // correctly on both Windows and Unix systems.
  snapshotScript = snapshotScript.replace('const pathSeparator = null', `const pathSeparator = ${JSON.stringify(path.sep)}`)

  const auxiliaryData = JSON.stringify(options.auxiliaryData || {})
  const auxiliaryDataAssignment = 'var snapshotAuxiliaryData = {}'
  const auxiliaryDataAssignmentStartIndex = snapshotScript.indexOf(auxiliaryDataAssignment)
  const auxiliaryDataAssignmentEndIndex = auxiliaryDataAssignmentStartIndex + auxiliaryDataAssignment.length
  snapshotScript =
    snapshotScript.slice(0, auxiliaryDataAssignmentStartIndex) +
    `var snapshotAuxiliaryData = ${auxiliaryData};` +
    snapshotScript.slice(auxiliaryDataAssignmentEndIndex)

  // Replace `require.definitions = {}` with an assignment of the actual definitions
  // of all the modules.
  const definitionsAssignment = 'customRequire.definitions = {}'
  const definitionsAssignmentStartIndex = snapshotScript.indexOf(definitionsAssignment)
  const definitionsAssignmentEndIndex = definitionsAssignmentStartIndex + definitionsAssignment.length
  const sections = []
  let sectionStartRow = getLineCount(snapshotScript.slice(0, definitionsAssignmentStartIndex)) + 1
  let definitions = ''
  const moduleFilePaths = Object.keys(moduleASTs)
  for (let i = 0; i < moduleFilePaths.length; i++) {
    const relativePath = moduleFilePaths[i]
    const source = moduleASTs[relativePath]
    const sourceMapSuffix = withSourceMaps && moduleSourceMaps[relativePath]
      ? `\n${moduleSourceMaps[relativePath]}\n`
      : ''
    const resolvedSource = `${source}${sourceMapSuffix}`

    const lineCount = getLineCount(resolvedSource)
    sections.push({relativePath, startRow: sectionStartRow, endRow: (sectionStartRow + lineCount) - 2})
    const moduleDefinition = withSourceMaps
      ? `eval(${JSON.stringify(resolvedSource)})`
      : resolvedSource
    definitions += `${JSON.stringify(relativePath)}: ${moduleDefinition},\n`
    sectionStartRow += lineCount
  }

  snapshotScript =
    snapshotScript.slice(0, definitionsAssignmentStartIndex) +
    `customRequire.definitions = {\n${definitions}\n  };` +
    snapshotScript.slice(definitionsAssignmentEndIndex)

  // The following code to generate metadata to map line numbers in the snapshot
  // must remain at the end of this function to ensure all the embedded code is
  // accounted for.
  const sectionsAssignment = 'snapshotAuxiliaryData.snapshotSections = []'
  const sectionsAssignmentStartIndex = snapshotScript.indexOf(sectionsAssignment)
  const sectionsAssignmentEndIndex = sectionsAssignmentStartIndex + sectionsAssignment.length
  snapshotScript =
    snapshotScript.slice(0, sectionsAssignmentStartIndex) +
    `snapshotAuxiliaryData.snapshotSections = ${JSON.stringify(sections)}` +
    snapshotScript.slice(sectionsAssignmentEndIndex)

  return snapshotScript
}

function getSourceMappingURL(sourceMap) {
  const base64Map = Buffer.from(JSON.stringify(sourceMap), 'utf8').toString('base64')
  return `//@ sourceMappingURL=data:application/json;charset=utf-8;base64,${base64Map}`
}

function getLineCount (text) {
  let lineCount = 1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineCount++
  }
  return lineCount
}
