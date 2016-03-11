var fs = require('fs')
var path = require('path')
var request = require('request')
var H = require('highland')
var JSONStream = require('JSONStream')
var wellknown = require('wellknown')

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

function download (config, dir, writer, callback) {
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
    .errors(callback)
    .pipe(JSONStream.stringify())
    .on('end', callback)
    .pipe(fs.createWriteStream(path.join(dir, 'maps.json')))
}

function convert (config, dir, writer, callback) {
  var stream = fs.createReadStream(path.join(dir, 'maps.json'))
    .pipe(JSONStream.parse('*'))

  H(stream)
    .filter((map) => map.bbox_geom)
    .map((d) => ({
      id: d.id,
      type: 'st:Map',
      name: d.title,
      data: {
        description: d.description,
        nyplDigitalId: d.nypl_digital_id,
        uuid: d.uuid,
        parentUuid: d.parent_uuid,
        nyplUrl: 'http://digitalcollections.nypl.org/items/' + d.uuid
      },
      geometry: wellknown(d.bbox_geom),
      validSince: d.issue_year,
      validUntil: d.issue_year
    }))
    .flatten()
    .map(H.curry(writePit, writer))
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
