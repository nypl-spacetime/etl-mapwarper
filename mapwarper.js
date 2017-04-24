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

const getUrl = (perPage, page) => `http://maps.nypl.org/warper/maps.json?per_page=${perPage}&page=${page}`

function requestCallback (sleep, url, callback) {
  console.log('\tDownloading ' + url + ' (and sleeping ' + sleep + 'ms)')

  got(url, GOT_OPTIONS)
    .then((response) => {
      if (sleep) {
        setTimeout(() => {
          callback(null, response.body)
        }, sleep)
      } else {
        callback(null, response.body)
      }
    })
    .catch(callback)
}

function getUrls (perPage, items) {
  const count = Math.ceil(items / perPage)

  let urls = []
  for (var page = 1; page <= count; page++) {
    urls.push(getUrl(perPage, page))
  }

  return urls
}

function getMask (sleep, map, callback) {
  var maskStatus = map.mask_status
  if (maskStatus === 'masked' || maskStatus === 'masking') {
    console.log(`          Getting mask for map ${map.id}`)

    maskToGeoJSON.getMaskAndTransform({
      mapId: map.id,
      transform: map.transform_options
    }, (err, geojson) => {
      if (err) {
        console.error(err.message)
        map.maskError = err.message
      } else {
        console.log(`          Transformed mask for map ${map.id}: ${geojson.coordinates[0].length} points`)
        map.mask = geojson
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

function download (config, dirs, tools, callback) {
  const sleepMs = 2000
  const perPage = 250

  maskToGeoJSON.gdalInstalled((err) => {
    if (err) {
      callback(new Error('GDAL is not installed - GDAL is needed to convert Map Warper masks to GeoJSON'))
    } else {
      got(getUrl(1, 1), GOT_OPTIONS)
        .then((response) => {
          H([response.body.total_entries])
            .map(H.curry(getUrls, perPage))
            .flatten()
            .map(H.curry(requestCallback, sleepMs))
            .nfcall([])
            .series()
            .map((body) => body.items)
            .flatten()
            .compact()
            .map(H.curry(getMask, sleepMs / 20))
            .nfcall([])
            .series()
            .errors(callback)
            .map(JSON.stringify)
            .intersperse('\n')
            .pipe(fs.createWriteStream(path.join(dirs.current, 'maps.ndjson')))
            .on('finish', callback)
        })
        .catch(callback)
    }
  })
}

const checkMap = (map) => Object.assign(map, {logs: getLogs(map)})

function getLogs (map) {
  var log = {
    id: map.id,
    nyplDigitalId: map.nypl_digital_id,
    logs: []
  }

  const mapStatus = map.status
  const maskStatus = map.mask_status

  // Check mask's number of coordinates:
  var minCoordinatesCount = 4
  if (map.mask && map.mask.coordinates[0].length < minCoordinatesCount) {
    log.logs.push({
      type: 'mask_coordinates_count',
      message: `Mask has ${map.mask.coordinates[0].length} coordinates (should have at least ${minCoordinatesCount})`
    })
  }

  // Check if mask has self-intersections:
  if (map.mask) {
    const kinks = turf.kinks(map.mask)
    if (kinks.features.length) {
      log.logs.push({
        type: 'self_intersection',
        message: `Mask has ${kinks.features.length} self-intersections`
      })
    }
  }

  // Check if mask's coordinates are valid:
  if (map.mask) {
    const coordValid = (coord) => {
      const lat = coord[1]
      const lon = coord[0]

      return lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90
    }

    const allValid = turf.meta.coordAll(map.mask)
      .reduce((a, b) => a && coordValid(b), true)

    if (!allValid) {
      log.logs.push({
        type: 'invalid_coordinates',
        message: `Mask has invalid coordinates`
      })
    }
  }

  // Check if mask is a MultiPolygon:
  if (map.mask && map.mask.coordinates.length !== 1) {
    log.logs.push({
      type: 'multipolygon',
      message: `Mask is a MultiPolygon with ${map.mask.coordinates.length} polygons`
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

  if (log.logs.length === 0 && !(map.mask && map.mask.coordinates)) {
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
  } else {
    return null
  }
}

function transform (config, dirs, tools, callback) {
  H(fs.createReadStream(path.join(dirs.previous, 'maps.ndjson')))
    .split()
    .compact()
    .map(JSON.parse)
    .filter((map) => map.bbox)
    .filter((map) => map.map_type === 'is_map')
    .map(checkMap)
    .compact()
    .map((map) => {
      if (map.logs) {
        // Something's not right! Only write logs, do not write map!
        return map.logs
      } else {
        const geometry = map.mask
        const area = Math.round(turf.area(geometry))

        var object = {
          id: map.id,
          type: 'st:Map',
          name: map.title,
          data: {
            description: map.description,
            nyplDigitalId: map.nypl_digital_id,
            uuid: map.uuid,
            parentUuid: map.parent_uuid,
            masked: map.mask_status === 'masked' || map.mask_status === 'masking',
            nyplUrl: `http://digitalcollections.nypl.org/items/${map.uuid}`,
            area: area * 0.000001
          },
          geometry: geometry
        }

        if (map.depicts_year || map.issue_year) {
          object.validSince = map.depicts_year || map.issue_year
          object.validUntil = map.depicts_year || map.issue_year
        }

        return {
          type: 'object',
          obj: object
        }
      }
    })
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
