var fs = require('fs');
var path = require('path');
var request = require('request');
var H = require('highland');
var JSONStream = require('JSONStream');
var wellknown = require('wellknown');

var getUrl = function(perPage, page) {
  return 'http://maps.nypl.org/warper/maps.json?per_page=' + perPage + '&page=' + page;
};

var requestStream = function(url) {
  return H(request(url))
    .stopOnError(function(err) {
      console.error(err);
    })
    .split()
    .map(JSON.parse);
};

var requestCallback = function(sleep, url, callback) {
  console.log('\tDownloading ' + url + ' (and sleeping ' + sleep + 'ms)');

  request(url, function(err, response, body) {
    if (err) {
      callback(err);
    } else {
      if (sleep) {
        setTimeout(function() {
          callback(null, JSON.parse(body));
        }, sleep);
      } else {
        callback(null, JSON.parse(body));
      }
    }
  });
};

var getUrls = function(perPage, items) {
  var count = Math.ceil(items / perPage);

  var urls = [];
  for (var page = 1; page <= count; page++) {
    urls.push(getUrl(perPage, page));
  }

  return urls;
};

var writePit = function(writer, pit, callback) {
  var data = [
    {
      type: 'pit',
      obj: pit
    }
  ];

  writer.writeObjects(data, function(err) {
    callback(err);
  });
};

function download(config, dir, writer, callback) {
  var perPage = 250;

  return requestStream(getUrl(1, 1))
    .map(function(body) {
      return body.total_entries;
    })
    .map(H.curry(getUrls, perPage))
    .flatten()
    .map(H.curry(requestCallback, 2000))
    .nfcall([])
    .series()
    .map(function(body) {
      return body.items;
    })
    .flatten()
    .compact()
    .errors(function(err) {
      callback(err);
    })
    .pipe(JSONStream.stringify())
    .on('end', function() {
      callback();
    })
    .pipe(fs.createWriteStream(path.join(dir, 'maps.json')));
}

function convert(config, dir, writer, callback) {
  var stream = fs.createReadStream(path.join(dir, 'maps.json'))
    .pipe(JSONStream.parse('*'));

  H(stream)
    .filter(function(map) {
      return map.bbox_geom;
    })
    .map(function(d) {
      return {
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
      };
    })
    .flatten()
    .map(H.curry(writePit, writer))
    .nfcall([])
    .series()
    .errors(function(err) {
      console.error(err);
    })
    .done(function() {
      callback();
    });
}

// ==================================== API ====================================

module.exports.title = 'Mapwarper';
module.exports.url = 'http://maps.nypl.org/';

module.exports.steps = [
  download,
  convert
];
