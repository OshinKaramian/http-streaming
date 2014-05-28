(function(window, document) {
  'use strict';
  var segmentDuration = 9, // seconds
      segmentCount = 100,
      duration = segmentDuration * segmentCount,
      propagationDelay = 1,

      runSimulation,
      playlistResponse,
      player,
      runButton,
      parameters,
      addTimePeriod,
      networkTimeline,
      timePeriod,
      timeline,

      displayTimeline;

  // mock out the environment and dependencies
  videojs.options.flash.swf = '../../node_modules/video.js/dist/video-js/video-js.swf';
  videojs.Hls.SegmentParser = function() {
    this.getFlvHeader = function() {
      return new Uint8Array([]);
    };
    this.parseSegmentBinaryData = function() {};
    this.flushTags = function() {};
    this.tagsAvailable = function() {
      return false;
    };
  };

  // a dynamic number of time-bandwidth pairs may be defined to drive the simulation
  addTimePeriod = document.querySelector('.add-time-period');
  networkTimeline = document.querySelector('.network-timeline');
  timePeriod = networkTimeline.cloneNode(true);
  addTimePeriod.addEventListener('click', function() {
    var clone = timePeriod.cloneNode(true),
        fragment = document.createDocumentFragment(),
        count = networkTimeline.querySelectorAll('input.bandwidth').length,
        time = clone.querySelector('.time'),
        bandwidth = clone.querySelector('input.bandwidth');

    time.name = 'time' + count;
    bandwidth.name = 'bandwidth' + count;
    while (clone.childNodes.length) {
      fragment.appendChild(clone.childNodes[0]);
    }
    networkTimeline.appendChild(fragment);
  });

  // collect the simulation parameters
  parameters = function() {
    var times = Array.prototype.slice.call(document.querySelectorAll('.time')),
        bandwidths = document.querySelectorAll('input.bandwidth'),
        playlists = Array.prototype.slice.call(document.querySelectorAll('input.bitrate'));

    return {
      playlists: playlists.map(function(input) {
        return +input.value;
      }),
      bandwidths: times.reduce(function(conditions, time, i) {
        return conditions.concat({
          time: +time.value,
          bandwidth: +bandwidths[i].value
        });
      }, [])
    };
  };

  // send a mock playlist response
  playlistResponse = function(bitrate) {
    var i = segmentCount,
        response = '#EXTM3U\n';

    while (i--) {
      response += '#EXTINF:' + segmentDuration + ',\n';
      response += bitrate + '-' + (segmentCount - i) + '\n';
    }
    response += '#EXT-X-ENDLIST\n';

    return response;
  };

  // run the simulation
  runSimulation = function(options, done) {
    var results = {
          bandwidth: [],
          playlists: [],
          options: options
        },
        bandwidths = options.bandwidths,
        fixture = document.getElementById('fixture'),

        realSetTimeout = window.setTimeout,
        clock,
        fakeXhr,
        requests,
        video,
        t = 0,
        i = 0;

    // clean up the last run if necessary
    if (player) {
      player.dispose();
    };

    // mock out the environment
    clock = sinon.useFakeTimers();
    fakeXhr = sinon.useFakeXMLHttpRequest();
    requests = [];
    fakeXhr.onCreate = function(xhr) {
      xhr.startTime = t;
      requests.push(xhr);
    };

    // initialize the HLS tech
    fixture.innerHTML = '';
    video = document.createElement('video');
    fixture.appendChild(video);
    player = videojs(video, {
      techOrder: ['hls'],
      sources: [{
        src: 'http://example.com/master.m3u8',
        type: 'application/x-mpegurl'
      }]
    });

    player.ready(function() {
      // run next tick so that Flash doesn't swallow exceptions
      realSetTimeout(function() {
        var master = '#EXTM3U\n' +
              options.playlists.reduce(function(playlists, value) {
                return playlists +
                  '#EXT-X-STREAM-INF:' + value + '\n' +
                  'playlist-' + value + '\n';
              }, ''),
            buffered = 0,
            currentTime = 0;

        // mock out buffered and currentTime
        player.buffered = function() {
          return videojs.createTimeRange(0, currentTime + buffered);
        };
        player.currentTime = function() {
          return currentTime;
        };

        // respond to the playlist requests
        requests.shift().respond(200, null, master);
        requests[0].respond(200, null, playlistResponse(+requests[0].url.match(/\d+$/)));
        requests.shift();

        bandwidths.sort(function(left, right) {
          return left.time - right.time;
        });

        // advance time and collect simulation results
        for (t = i = 0; t < duration; clock.tick(1 * 1000), t++) {

          // determine the bandwidth value at this moment
          while (bandwidths[i + 1] && bandwidths[i + 1].time <= t) {
            i++;
          }
          results.bandwidth.push({
            time: t,
            bandwidth: bandwidths[i].bandwidth
          });

          // deliver responses if they're ready
          requests = requests.reduce(function(remaining, request) {
            var arrival = request.startTime + propagationDelay,
                delivered = Math.max(0, bandwidths[i].bandwidth * (t - arrival)),
                segmentSize = +request.url.match(/(\d+)-\d+$/)[1] * segmentDuration;

            // playlist responses
            if (/playlist-\d+$/.test(request.url)) {
              // playlist responses have no trasmission time
              if (t === arrival) {
                request.respond(200, null, playlistResponse(+requests[0].url.match(/\d+$/)));
                return remaining;
              }
              // the response has not arrived. re-enqueue it for later.
              return remaining.concat(request);
            }

            // segment responses
            if (delivered > segmentSize) {
              // segment responses are delivered after the propagation
              // delay and the transmission time have elapsed
              buffered += segmentDuration;
              request.status = 200;
              request.response = new Uint8Array(segmentSize);
              request.setResponseBody('');
              return remaining;
            } else {
              if (t === arrival) {
                // segment response headers arrive after the propogation delay

                results.playlists.push({
                  time: t,
                  bitrate: +request.url.match(/(\d+)-\d+$/)[1]
                });
                request.setResponseHeaders({
                  'Content-Type': 'video/mp2t'
                });
              }
              // the response has not arrived fully. re-enqueue it for
              // later
              return remaining.concat(request);
            }
          }, []);

          // simulate playback
          if (buffered > 0) {
            buffered--;
            currentTime++;
          }
          player.trigger('timeupdate');
        }

        // restore the environment
        clock.restore();
        fakeXhr.restore();

        done(null, results);
      }, 0);
    });
  };
  runButton = document.getElementById('run-simulation');
  runButton.addEventListener('click', function() {
    runSimulation(parameters(), displayTimeline);
  });

  // render the timeline with d3
  timeline = document.querySelector('.timeline');
  timeline.innerHTML = '';
  (function() {
    var margin = {
          top: 20,
          right: 80,
          bottom: 30,
          left: 50
        },
        width = 960 - margin.left - margin.right,
        height = 500 - margin.top - margin.bottom,
        svg;
    svg = d3.select('.timeline').append('svg')
      .attr('width', width + margin.left + margin.right)
      .attr('height', height + margin.top + margin.bottom)
    .append('g')
      .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

    displayTimeline = function(error, data) {
      var x = d3.scale.linear().range([0, width]),
          y0 = d3.scale.linear().range([height, 0]),
          y1 = d3.scale.ordinal().rangeRoundBands([height, 0], 0.1),

          timeAxis = d3.svg.axis().scale(x).orient('bottom'),
          bandwidthAxis = d3.svg.axis().scale(y0).orient('left'),
          segmentBitrateAxis = d3.svg.axis().scale(y1).orient('right'),

          bandwidthLine = d3.svg.line()
            .interpolate('basis')
            .x(function(data) {
              return x(data.time);
            })
            .y(function(data) {
              return y0(data.bandwidth);
            });

      x.domain(d3.extent(data.bandwidth, function(data) {
        return data.time;
      }));
      y0.domain([0, d3.max(data.bandwidth, function(data) {
        return data.bandwidth;
      })]);
      y1.domain(data.options.playlists);

      // time axis
      svg.selectAll('.axis').remove();
      svg.append('g')
        .attr('class', 'x axis')
        .attr('transform', 'translate(0,' + height + ')')
        .call(timeAxis);

      // bandwidth axis
      svg.append('g')
        .attr('class', 'y axis')
        .call(bandwidthAxis)
      .append('text')
        .attr('transform', 'rotate(-90)')
        .attr('y', 6)
        .attr('dy', '.71em')
        .style('text-anchor', 'end')
        .text('Bandwidth (b/s)');

      // segment bitrate axis
      svg.append('g')
        .attr('class', 'y axis')
        .attr('transform', 'translate(' + width + ', 0)')
        .call(segmentBitrateAxis)
      .append('text')
        .attr('transform', 'rotate(-90)')
        .attr('y', 6)
        .attr('dy', '-.71em')
        .style('text-anchor', 'end')
        .text('Bitrate (b/s)');

      // bandwidth line
      svg.selectAll('.bandwidth').remove();
      svg.append('path')
        .datum(data.bandwidth)
        .attr('class', 'line bandwidth')
        .attr('d', bandwidthLine);

      // segment bitrate dots
      svg.selectAll('.segment-bitrate').remove();
      svg.selectAll('.segment-bitrate')
        .data(data.playlists)
      .enter().append('circle')
        .attr('class', 'dot segment-bitrate')
        .attr('r', 3.5)
        .attr('cx', function(playlist) {
          return x(playlist.time);
        })
        .attr('cy', function(playlist) {
          return y1(playlist.bitrate) + (y1.rangeBand() / 2);
        });
    };
  })();

  runSimulation(parameters(), displayTimeline);

})(window, document);
