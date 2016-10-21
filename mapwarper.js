var fs = require('fs')
var path = require('path')
var request = require('request')
var H = require('highland')
var R = require('ramda')
var JSONStream = require('JSONStream')
var turf = {
  area: require('turf-area')
}
var maskToGeoJSON = require('mask-to-geojson')

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

const checkMap = (map) => Object.assign(map, {logs: getLogs(map)})

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

  // TODO: see if coordinates are between 90 and 180 etc.!
  // TODO: find maps that cause postgis antipodal error, and log them

  if (map.mask && map.mask.coordinates) {
    const usaBbox = [
      [
        -139.5703125,
        9.44906182688142
      ],
      [
        -48.8671875,
        52.26815737376817
      ]
    ]

    const inUSA = (coor) => coor[0] > usaBbox[0][0] &&
      coor[0] < usaBbox[1][0] &&
      coor[1] > usaBbox[0][1] &&
      coor[1] < usaBbox[1][1]

    const allCoordinatesInUsa = R.all(R.identity, R.splitEvery(2, R.flatten(map.mask.coordinates))
      .map(inUSA))

    if (!allCoordinatesInUsa) {
      log.logs.push({
        type: 'outside_usa',
        message: 'Mask has coordinates outside of USA'
      })
    }
  }

  if (map.mask && map.mask.coordinates.length !== 1) {
    log.logs.push({
      type: 'multipolygon',
      message: 'Mask is MultiPolygon'
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
  var stream = fs.createReadStream(path.join(dirs.previous, 'maps.json'))
    .pipe(JSONStream.parse('*'))

  H(stream)
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
            nyplUrl: 'http://digitalcollections.nypl.org/items/' + map.uuid,
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
