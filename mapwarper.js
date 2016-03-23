var fs = require('fs')
var path = require('path')
var request = require('request')
var H = require('highland')
var JSONStream = require('JSONStream')
var wellknown = require('wellknown')
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

var writePit = function (writer, pit, callback) {
  var data = [
    {
      type: 'pit',
      obj: pit
    }
  ]

  writer.writeObjects(data, callback)
}

function getMask(sleep, map, callback) {
  var maskStatus = map.mask_status
  if (maskStatus === 'masked' || maskStatus === 'masking') {
    console.log(`          Getting mask for map ${map.id}`)
    maskToGeoJSON.getMaskAndTransform({
      mapId: map.id
    }, (err, geojson) => {
      if (err) {
        console.error(err)
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

function convert (config, dirs, tools, callback) {
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

      if (map.mask && map.mask.coordinates[0].length >= 4) {
        pit.geometry = map.mask

        // Compute map area in square meters
        var area = Math.round(turf.area(map.mask))
        pit.data.area = area
      } else if (map.bbox_geom) {
        pit.geometry = wellknown(map.bbox_geom)
      }

      if (map.depicts_year || map.issue_year) {
        pit.validSince = map.depicts_year || map.issue_year
        pit.validUntil = map.depicts_year || map.issue_year
      }

      return pit
    })
    .flatten()
    .map(H.curry(writePit, tools.writer))
    .nfcall([])
    .series()
    .errors(console.error)
    .done(callback)
}

// ==================================== API ====================================

module.exports.steps = [
  download,
  convert
]
