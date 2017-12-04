const fs = require('fs')
const path = require('path')
const got = require('got')
const H = require('highland')
const turf = {
  area: require('@turf/area'),
  kinks: require('@turf/kinks'),
  meta: require('@turf/meta')
}
const maskToGeoJSON = require('mask-to-geojson')

const GOT_OPTIONS = {
  timeout: 25 * 1000,
  retries: 5,
  json: true
}

const SLEEP_MS = 2000

const BASE_URL = 'http://maps.nypl.org/warper/'
const PER_PAGE = 250

const paginate = (page = 1, perPage = PER_PAGE) => `per_page=${perPage}${page > 1 ? `&page=${page}` : ''}`
const getMapsUrl = (page, perPage) => `${BASE_URL}maps.json?${paginate(page, perPage)}`
const getLayersUrl = (page, perPage) => `${BASE_URL}layers.json?${paginate(page, perPage)}`
const getMapLayersUrl = (mapId, page, perPage) => `${BASE_URL}maps/${mapId}/layers.json?${paginate(page, perPage)}`

function downloadUrl (url, sleep) {
  console.log('\tDownloading ' + url + (sleep ? ' (and sleeping ' + sleep + 'ms)' : ''))

  return got(url, GOT_OPTIONS)
    .then((response) => {
      if (sleep) {
        return new Promise((resolve, reject) => {
          setTimeout(() => resolve(response.body), sleep)
        })
      } else {
        return response.body
      }
    })
}

function downloadUrlCallback (sleep, url, callback) {
  downloadUrl(url, sleep)
    .then((body) => callback(null, body))
    .catch(callback)
}

function getMapsUrls (totalItems) {
  const count = Math.ceil(totalItems / PER_PAGE)
  const urls = Array.from({length: count})
    .map((d, index) => getMapsUrl(index + 1))

  return urls
}

function getMapLayers (map, callback) {
  downloadLayers(map.id, SLEEP_MS / 10)
    .then((results) => {
      const layerIds = results
        .filter((result) => result.type === 'layer')
        .map((result) => result.layer.id)

      const layerErrors = results
        .filter((result) => result.type === 'error')
        .map((result) => ({
          error: result.error,
          url: result.url
        }))

      callback(null, Object.assign(map, {
        layerIds,
        layerErrors
      }))
    })
    .catch(callback)
}

function getMask (sleep, map, callback) {
  const maskStatus = map.mask_status
  if (maskStatus === 'masked' || maskStatus === 'masking') {
    console.log(`          Getting mask for map ${map.id}`)

    maskToGeoJSON.getMaskAndTransform({
      mapId: map.id,
      transform: map.transform_options
    }, (err, geojson, gcps, mask) => {
      if (err) {
        console.error(err.message)
        map.maskError = err.message
      } else {
        console.log(`          Transformed mask for map ${map.id}: ${geojson.coordinates[0].length} points`)

        map.mask = mask
        map.gcps = gcps
        map.maskGeometry = geojson
      }

      if (sleep) {
        setTimeout(() => {
          callback(null, map)
        }, sleep)
      } else {
        callback(null, map)
      }
    })
  } else {
    callback(null, map)
  }
}

async function downloadLayers (mapId, sleep) {
  let page = 1
  const results = []

  while (true) {
    const url = mapId ? getMapLayersUrl(mapId, page) : getLayersUrl(page)

    let result
    try {
      result = await downloadUrl(url, sleep)
    } catch (err) {
      results.push({
        type: 'error',
        mapId,
        page,
        url,
        error: err.message
      })
    }

    if (result && result.items && result.items.length) {
      results.push(...result.items.map((result) => ({
        type: 'layer',
        layer: result
      })))

      if (result.items.length < PER_PAGE) {
        break
      }
    } else {
      break
    }

    page += 1
  }

  return results
}

function download (config, dirs, tools, callback) {
  const mapsWriteStream = fs.createWriteStream(path.join(dirs.current, 'maps.ndjson'))
  const layersWriteStream = fs.createWriteStream(path.join(dirs.current, 'layers.ndjson'))

  downloadLayers()
    .then((results) => {
      H(results)
        .flatten()
        .filter((result) => result.type === 'layer')
        .map((result) => ({
          type: 'layer',
          data: result.layer
        }))
        .map(JSON.stringify)
        .intersperse('\n')
        .pipe(layersWriteStream)

      maskToGeoJSON.gdalInstalled((err) => {
        if (err) {
          callback(new Error('GDAL is not installed - GDAL is needed to convert Map Warper masks to GeoJSON'))
        } else {
          let mapLayers = H.pipeline()

          if (config && config.includeMapLayers) {
            mapLayers = H.pipeline(
              H.map(H.curry(getMapLayers)),
              H.nfcall([]),
              H.series(),
              H.stopOnError(callback)
            )
          }

          downloadUrl(getMapsUrl())
            .then((body) => {
              if (!body || !body.total_entries) {
                throw new Error('Error in body.total_entries')
              }

              H([body.total_entries])
                .map(H.curry(getMapsUrls))
                .flatten()
                .map(H.curry(downloadUrlCallback, SLEEP_MS))
                .nfcall([])
                .series()
                .map((body) => body.items)
                .stopOnError(callback)
                .flatten()
                .compact()
                .pipe(mapLayers)
                .errors(callback)
                .map(H.curry(getMask, SLEEP_MS / 20))
                .nfcall([])
                .series()
                .errors(callback)
                .map((map) => ({
                  type: 'map',
                  data: map
                }))
                .map(JSON.stringify)
                .intersperse('\n')
                .pipe(mapsWriteStream)
                .on('finish', callback)
            })
            .catch(callback)
        }
      })
    })
    .catch(callback)
}

function getLogs (map) {
  const log = {
    id: map.id,
    imageId: map.nypl_digital_id,
    logs: []
  }

  // Check if mask is a MultiPolygon:
  if (!map.uuid) {
    log.logs.push({
      type: 'missing_uuid',
      message: `Map has no UUID`
    })
  }

  const mapStatus = map.status
  const maskStatus = map.mask_status

  // Check mask's number of coordinates:
  const minCoordinatesCount = 4
  if (map.maskGeometry && map.maskGeometry.coordinates[0].length < minCoordinatesCount) {
    log.logs.push({
      type: 'mask_coordinates_count',
      message: `Mask has ${map.maskGeometry.coordinates[0].length} coordinates (should have at least ${minCoordinatesCount})`
    })
  }

  // Check if mask has self-intersections:
  if (map.maskGeometry) {
    const kinks = turf.kinks(map.maskGeometry)
    if (kinks.features.length) {
      log.logs.push({
        type: 'self_intersection',
        message: `Mask has ${kinks.features.length} self-intersections`
      })
    }
  }

  // Check if mask's coordinates are valid:
  if (map.maskGeometry) {
    const coordValid = (coord) => {
      const lat = coord[1]
      const lon = coord[0]

      return lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90
    }

    const allValid = turf.meta.coordAll(map.maskGeometry)
      .reduce((a, b) => a && coordValid(b), true)

    if (!allValid) {
      log.logs.push({
        type: 'invalid_coordinates',
        message: `Mask has invalid coordinates`
      })
    }
  }

  // Check if mask is a MultiPolygon:
  if (map.maskGeometry && map.maskGeometry.coordinates.length !== 1) {
    log.logs.push({
      type: 'multipolygon',
      message: `Mask is a MultiPolygon with ${map.maskGeometry.coordinates.length} polygons`
    })
  }

  if (map.maskError) {
    log.logs.push({
      type: 'mask_to_geojson',
      message: map.maskError
    })
  }

  if (mapStatus === 'warped' && maskStatus === 'unmasked') {
    log.logs.push({
      type: 'warped_but_unmasked',
      message: 'Map is warped, but not masked'
    })
  }

  if (mapStatus !== 'warped' && mapStatus !== 'published' && maskStatus !== 'unmasked') {
    log.logs.push({
      type: 'unwarped_but_masked',
      message: 'Map is masked, but not warped'
    })
  }

  if (log.logs.length === 0 && !(map.maskGeometry && map.maskGeometry.coordinates)) {
    log.logs.push({
      type: 'mask_missing',
      message: 'Map is unmasked'
    })
  }

  if (log.logs.length) {
    return {
      type: 'log',
      obj: log
    }
  }
}

function getYear (object) {
  const year = object.depicts_year || object.issue_year

  if (year) {
    return parseInt(year)
  }
}

const getLayerId = (layerId) => `layer-${layerId}`

function getLayerRelations (map) {
  if (!map.layerIds) {
    return []
  }

  return map.layerIds.map((layerId) => ({
    type: 'relation',
    obj: {
      type: 'st:in',
      from: map.id,
      to: getLayerId(layerId)
    }
  }))
}

function roundDecimals (number, decimals) {
  const n = Math.pow(10, decimals)
  return Math.round(number * n) /n
}

function transformMap (map) {
  if (!map.bbox || map.map_type !== 'is_map') {
    return
  }

  const logs = getLogs(map)
  if (logs) {
    // Something's not right! Only write logs, do not write map!
    return logs
  } else {
    const geometry = map.maskGeometry
    const area = Math.round(turf.area(geometry))

    const inset = String(map.uuid).startsWith('inset')

    const object = {
      type: 'object',
      obj: {
        id: map.id,
        type: 'st:Map',
        name: map.title,
        validSince: getYear(map),
        validUntil: getYear(map),
        data: {
          description: map.description,
          imageId: map.nypl_digital_id,
          uuid: map.uuid,
          parentUuid: map.parent_uuid,
          inset,
          masked: map.mask_status === 'masked' || map.mask_status === 'masking',
          nyplUrl: `http://digitalcollections.nypl.org/items/${map.uuid}`,
          tileUrl: `http://maps.nypl.org/warper/maps/tile/${map.id}/{z}/{x}/{y}.png`,
          area: roundDecimals(area * 0.000001, 5),
          gcps: map.gcps
        },
        geometry
      }
    }

    return [
      object,
      ...getLayerRelations(map)
    ]
  }
}

function transformLayer (layer) {
  return {
    type: 'object',
    obj: {
      id: getLayerId(layer.id),
      type: 'st:Map',
      name: layer.name,
      validSince: getYear(layer),
      validUntil: getYear(layer),
      data: {
        mapCount: layer.maps_count,
        tileUrl: `http://maps.nypl.org/warper/layers/tile/${layer.id}/{z}/{x}/{y}.png`,
        bbox: layer.bbox ? layer.bbox.split(',').map(parseFloat) : undefined
      }
    }
  }
}

function transform (config, dirs, tools, callback) {
  const transforms = {
    map: transformMap,
    layer: transformLayer
  }

  H(['maps.ndjson', 'layers.ndjson'])
    .map((file) => H(fs.createReadStream(path.join(dirs.previous, file))).append('\n'))
    .sequence()
    .split()
    .compact()
    .map(JSON.parse)
    .map((line) => transforms[line.type] && transforms[line.type](line.data))
    .compact()
    .flatten()
    .map(H.curry(tools.writer.writeObject))
    .nfcall([])
    .series()
    .errors(callback)
    .done(callback)
}

// ==================================== API ====================================

module.exports.steps = [
  download,
  transform
]
