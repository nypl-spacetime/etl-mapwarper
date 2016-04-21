var fs = require('fs')
var path = require('path')
var request = require('request')
var H = require('highland')
var JSONStream = require('JSONStream')
var wellknown = require('wellknown')
var turf = {
  area: require('turf-area'),
  buffer: require('turf-buffer'),
  intersect: require('turf-intersect')
}
var maskToGeoJSON = require('mask-to-geojson')

const wholeWorld = require('./whole-world.json')

var getUrl = function (perPage, page) {
  return `http://maps.nypl.org/warper/maps.json?per_page=${perPage}&page=${page}`
}

var requestStream = function (url) {
  return H(request(url))
    .stopOnError(console.error)
    .split()
    .map(JSON.parse)
}

var requestCallback = function (sleep, url, callback) {
  console.log('\tDownloading ' + url + ' (and sleeping ' + sleep + 'ms)')

  request(url, function (err, response, body) {
    if (err) {
      callback(err)
    } else {
      if (sleep) {
        setTimeout(() => {
          callback(null, JSON.parse(body))
        }, sleep)
      } else {
        callback(null, JSON.parse(body))
      }
    }
  })
}

var getUrls = function (perPage, items) {
  var count = Math.ceil(items / perPage)

  var urls = []
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
      mapId: map.id
    }, (err, geojson) => {
      if (err) {
        console.error(err)
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

  return requestStream(getUrl(1, 1))
    .map((body) => body.total_entries)
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
    .pipe(JSONStream.stringify())
    .on('end', callback)
    .pipe(fs.createWriteStream(path.join(dirs.current, 'maps.json')))
}

function getLogs (map) {
  var log = {
    id: map.id,
    nyplDigitalId: map.nypl_digital_id,
    logs: []
  }

  var mapStatus = map.status
  var maskStatus = map.mask_status

  var minCoordinatesCount = 4
  if (map.mask && map.mask.coordinates[0].length < minCoordinatesCount) {
    log.logs.push({
      type: 'mask_coordinates_count',
      message: `Mask has ${map.mask.coordinates[0].length} coordinates (should have at least ${minCoordinatesCount})`
    })
  }
  // TODO: kijk of coordinaten tussen de 90 en 180 zijn etc.!

  if (map.maskError) {
    log.logs.push({
      type: 'mask_to_geojson',
      message: map.maskError
    })
  }

  if (mapStatus === 'warped' && maskStatus === 'unmasked') {
    log.logs.push({
      type: 'mask_missing',
      message: 'Map is warped, but not masked'
    })
  }

  if (mapStatus !== 'warped' && mapStatus !== 'published' && maskStatus !== 'unmasked') {
    log.logs.push({
      type: 'unwarped_but_masked',
      message: 'Map is masked, but not warped'
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
  var stream = fs.createReadStream(path.join(dirs.previous, 'maps.json'))
    .pipe(JSONStream.parse('*'))

  H(stream)
    .filter((map) => map.bbox)
    .map((map) => {
      var pit = {
        id: map.id,
        type: 'st:Map',
        name: map.title,
        data: {
          description: map.description,
          nyplDigitalId: map.nypl_digital_id,
          uuid: map.uuid,
          parentUuid: map.parent_uuid,
          masked: map.mask_status === 'masked' || map.mask_status === 'masking',
          nyplUrl: 'http://digitalcollections.nypl.org/items/' + map.uuid
        }
      }

      var geometry
      if (map.mask && map.mask.coordinates[0].length >= 4) {
        geometry = map.mask
      } else if (map.bbox_geom) {
        geometry = wellknown(map.bbox_geom)
      }

      if (geometry) {
        var intersection

        var buffered = turf.buffer(
          {
            type: 'Feature',
            geometry: geometry
          }
          , 0.01, 'meters'
        )

        try {
          intersection = turf.intersect(wholeWorld, buffered)
        } catch (err) {
          console.error(pit.id, err)
          console.log(JSON.stringify(geometry))
          intersection = undefined
        }

        if (intersection) {
          pit.geometry = intersection.geometry

          // Compute map area in square kilometers
          var area = Math.round(turf.area(intersection.geometry))
          pit.data.area = area * 0.000001
        }
      }

      if (map.depicts_year || map.issue_year) {
        pit.validSince = map.depicts_year || map.issue_year
        pit.validUntil = map.depicts_year || map.issue_year
      }

      var logs = getLogs(map)

      return [
        logs,
        {
          type: 'pit',
          obj: pit
        }
      ]
    })
    .flatten()
    .compact()
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
