import videojs from 'video.js';
import BinUtils from './bin-utils';
import { stringToArrayBuffer } from './util/string-to-array-buffer';
import { transmux } from './segment-transmuxer';
import { probeMp4StartTime } from './util/segment';
import { inspect as inspectMp4 } from 'mux.js/lib/tools/mp4-inspector';
import { parseType as parseBoxType } from 'mux.js/lib/mp4/probe';

const { createTransferableMessage } = BinUtils;

export const REQUEST_ERRORS = {
  FAILURE: 2,
  TIMEOUT: -101,
  ABORTED: -102
};

/**
 * Turns segment byterange into a string suitable for use in
 * HTTP Range requests
 *
 * @param {Object} byterange - an object with two values defining the start and end
 *                             of a byte-range
 */
const byterangeStr = function(byterange) {
  let byterangeStart;
  let byterangeEnd;

  // `byterangeEnd` is one less than `offset + length` because the HTTP range
  // header uses inclusive ranges
  byterangeEnd = byterange.offset + byterange.length - 1;
  byterangeStart = byterange.offset;
  return 'bytes=' + byterangeStart + '-' + byterangeEnd;
};

/**
 * Defines headers for use in the xhr request for a particular segment.
 *
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 */
const segmentXhrHeaders = function(segment) {
  let headers = {};

  if (segment.byterange) {
    headers.Range = byterangeStr(segment.byterange);
  }
  return headers;
};

/**
 * Abort all requests
 *
 * @param {Object} activeXhrs - an object that tracks all XHR requests
 */
const abortAll = (activeXhrs) => {
  activeXhrs.forEach((xhr) => {
    xhr.abort();
  });
};

/**
 * Gather important bandwidth stats once a request has completed
 *
 * @param {Object} request - the XHR request from which to gather stats
 */
const getRequestStats = (request) => {
  return {
    bandwidth: request.bandwidth,
    bytesReceived: request.bytesReceived || 0,
    roundTripTime: request.roundTripTime || 0
  };
};

/**
 * If possible gather bandwidth stats as a request is in
 * progress
 *
 * @param {Event} progressEvent - an event object from an XHR's progress event
 */
const getProgressStats = (progressEvent) => {
  const request = progressEvent.target;
  const roundTripTime = Date.now() - request.requestTime;
  const stats = {
    bandwidth: Infinity,
    bytesReceived: 0,
    roundTripTime: roundTripTime || 0
  };

  stats.bytesReceived = progressEvent.loaded;
  // This can result in Infinity if stats.roundTripTime is 0 but that is ok
  // because we should only use bandwidth stats on progress to determine when
  // abort a request early due to insufficient bandwidth
  stats.bandwidth = Math.floor((stats.bytesReceived / stats.roundTripTime) * 8 * 1000);

  return stats;
};

/**
 * Handle all error conditions in one place and return an object
 * with all the information
 *
 * @param {Error|null} error - if non-null signals an error occured with the XHR
 * @param {Object} request -  the XHR request that possibly generated the error
 */
const handleErrors = (error, request) => {
  if (request.timedout) {
    return {
      status: request.status,
      message: 'HLS request timed-out at URL: ' + request.uri,
      code: REQUEST_ERRORS.TIMEOUT,
      xhr: request
    };
  }

  if (request.aborted) {
    return {
      status: request.status,
      message: 'HLS request aborted at URL: ' + request.uri,
      code: REQUEST_ERRORS.ABORTED,
      xhr: request
    };
  }

  if (error) {
    return {
      status: request.status,
      message: 'HLS request errored at URL: ' + request.uri,
      code: REQUEST_ERRORS.FAILURE,
      xhr: request
    };
  }

  return null;
};

/**
 * Handle responses for key data and convert the key data to the correct format
 * for the decryption step later
 *
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} finishProcessingFn - a callback to execute to continue processing
 *                                        this request
 */
const handleKeyResponse = (segment, finishProcessingFn) => (error, request) => {
  const response = request.response;
  const errorObj = handleErrors(error, request);

  if (errorObj) {
    return finishProcessingFn(errorObj, segment);
  }

  if (response.byteLength !== 16) {
    return finishProcessingFn({
      status: request.status,
      message: 'Invalid HLS key at URL: ' + request.uri,
      code: REQUEST_ERRORS.FAILURE,
      xhr: request
    }, segment);
  }

  const view = new DataView(response);

  segment.key.bytes = new Uint32Array([
    view.getUint32(0),
    view.getUint32(4),
    view.getUint32(8),
    view.getUint32(12)
  ]);
  return finishProcessingFn(null, segment);
};

/**
 * Handle init-segment responses
 *
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} finishProcessingFn - a callback to execute to continue processing
 *                                        this request
 */
const handleInitSegmentResponse = (segment, finishProcessingFn) => (error, request) => {
  const response = request.response;
  const errorObj = handleErrors(error, request);

  if (errorObj) {
    return finishProcessingFn(errorObj, segment);
  }

  // stop processing if received empty content
  if (response.byteLength === 0) {
    return finishProcessingFn({
      status: request.status,
      message: 'Empty HLS segment content at URL: ' + request.uri,
      code: REQUEST_ERRORS.FAILURE,
      xhr: request
    }, segment);
  }

  segment.map.bytes = new Uint8Array(request.response);
  return finishProcessingFn(null, segment);
};

/**
 * Response handler for segment-requests being sure to set the correct
 * property depending on whether the segment is encryped or not
 * Also records and keeps track of stats that are used for ABR purposes
 *
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} finishProcessingFn - a callback to execute to continue processing
 *                                        this request
 */
const handleSegmentResponse = (segment, finishProcessingFn) => (error, request) => {
  const response = request.response;
  const errorObj = handleErrors(error, request);

  if (errorObj) {
    return finishProcessingFn(errorObj, segment);
  }

  const newBytes =
    stringToArrayBuffer(request.responseText.substring(segment.lastReachedChar || 0));

  // stop processing if received empty content
  if (response.byteLength === 0) {
    return finishProcessingFn({
      status: request.status,
      message: 'Empty HLS segment content at URL: ' + request.uri,
      code: REQUEST_ERRORS.FAILURE,
      xhr: request
    }, segment);
  }

  segment.stats = getRequestStats(request);

  if (segment.key) {
    segment.encryptedBytes = new Uint8Array(newBytes);
  } else {
    segment.bytes = new Uint8Array(newBytes);
  }

  return finishProcessingFn(null, segment);
};

/**
 * Decrypt the segment via the decryption web worker
 *
 * @param {WebWorker} decrypter - a WebWorker interface to AES-128 decryption routines
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} dataFn - a callback that is executed when segment bytes are available
 *                            and ready to use
 * @param {Function} doneFn - a callback that is executed after decryption has completed
 */
const decryptSegment = (decrypter, segment, dataFn, doneFn) => {
  const decryptionHandler = (event) => {
    if (event.data.source === segment.requestId) {
      decrypter.removeEventListener('message', decryptionHandler);
      const decrypted = event.data.decrypted;

      segment.bytes = new Uint8Array(decrypted.bytes,
                                     decrypted.byteOffset,
                                     decrypted.byteLength);

      handleDecryptedBytes({
        segment,
        bytes: segment.bytes,
        isPartial: false,
        dataFn,
        doneFn
      });
    }
  };

  decrypter.addEventListener('message', decryptionHandler);

  // this is an encrypted segment
  // incrementally decrypt the segment
  decrypter.postMessage(createTransferableMessage({
    source: segment.requestId,
    encrypted: segment.encryptedBytes,
    key: segment.key.bytes,
    iv: segment.key.iv
  }), [
    segment.encryptedBytes.buffer,
    segment.key.bytes.buffer
  ]);
};

/**
 * The purpose of this function is to get the most pertinent error from the
 * array of errors.
 * For instance if a timeout and two aborts occur, then the aborts were
 * likely triggered by the timeout so return that error object.
 */
const getMostImportantError = (errors) => {
  return errors.reduce((prev, err) => {
    return err.code > prev.code ? err : prev;
  });
};

/**
 * This function waits for all XHRs to finish (with either success or failure)
 * before continueing processing via it's callback. The function gathers errors
 * from each request into a single errors array so that the error status for
 * each request can be examined later.
 *
 * @param {Object} activeXhrs - an object that tracks all XHR requests
 * @param {WebWorker} decrypter - a WebWorker interface to AES-128 decryption routines
 * @param {Function} dataFn - a callback that is executed when segment bytes are available
 *                            and ready to use
 * @param {Function} doneFn - a callback that is executed after all resources have been
 *                            downloaded and any decryption completed
 */
const waitForCompletion = (activeXhrs, decrypter, dataFn, doneFn) => {
  let errors = [];
  let count = 0;

  return (error, segment) => {
    if (error) {
      // If there are errors, we have to abort any outstanding requests
      abortAll(activeXhrs);
      errors.push(error);
    }
    count += 1;

    if (count === activeXhrs.length) {
      // Keep track of when *all* of the requests have completed
      segment.endOfAllRequests = Date.now();

      if (errors.length > 0) {
        const worstError = getMostImportantError(errors);

        return doneFn(worstError, segment);
      }
      if (segment.encryptedBytes) {
        return decryptSegment(decrypter, segment, dataFn, doneFn);
      }
      // Otherwise, everything is ready just continue
      handleDecryptedBytes({
        segment,
        bytes: segment.bytes,
        isPartial: false,
        dataFn,
        doneFn
      });
    }
  };
};

/**
 * Simple progress event callback handler that gathers some stats before
 * executing a provided callback with the `segment` object
 *
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} progressFn - a callback that is executed each time a progress event
 *                                is received
 * @param {Function} dataFn - a callback that is executed when segment bytes are available
 *                            and ready to use
 * @param {Event} event - the progress event object from XMLHttpRequest
 */
const handleProgress = (segment, progressFn, dataFn) => (event) => {
  const request = event.target;

  // don't support encrypted segments or fmp4 for now
  if (!segment.key) {
    const newBytes = stringToArrayBuffer(
      request.responseText.substring(segment.lastReachedChar || 0));

    const decryptedBytes = handleDecryptedBytes({
      segment,
      bytes: new Uint8Array(newBytes),
      isPartial: true,
      dataFn
    });

    segment.lastReachedChar += decryptedBytes;
  }

  segment.stats = videojs.mergeOptions(segment.stats, getProgressStats(event));

  // record the time that we receive the first byte of data
  if (!segment.stats.firstBytesReceivedAt && segment.stats.bytesReceived) {
    segment.stats.firstBytesReceivedAt = Date.now();
  }

  return progressFn(event, segment);
};

const completeMp4BoxesOffset = (bytes, reachesEndOfFile) => {
  let completeBoxesOffset = 0;
  let remainingBytes = bytes.byteLength - completeBoxesOffset;
  const view = new DataView(bytes.buffer);

  // 4 bytes for size, 4 bytes for box type
  while (remainingBytes >= 8) {
    let boxLength = view.getUint32(completeBoxesOffset);

    // from Part 12: ISO base media file format
    // "if size is 0, then this box is the last one in the file, and its contents extend
    // to the end of the file (normally only used for a Media Data Box)"
    if (boxLength === 0) {
      if (!reachesEndOfFile) {
        break;
      }

      boxLength = remainingBytes;
    }

    if (remainingBytes < boxLength) {
      // We don't have enough data to parse the full box
      break;
    }

    // Update offset to the last complete box
    completeBoxesOffset += boxLength;
    remainingBytes -= boxLength;
  }

  // The number of bytes used
  return completeBoxesOffset;
};

// TODO this will have to change
const rawDataForBox = (bytes, boxType) => {
  const view = new DataView(bytes.buffer);
  let offset = 4;

  for (; offset < bytes.length; offset += 4) {
    if (parseBoxType(bytes.subarray(offset, offset + 4)) === boxType) {
      const boxLength = view.getUint32(offset - 4);

      if (boxLength === 0) {
        return bytes.subarray(offset - 4);
      }

      return bytes.subarray(offset - 4, boxLength);
    }
  }

  return null;
};

const parseMp4AndNotify = ({segment, bytes, isPartial, dataFn, doneFn}) => {
  // const boxes = mp4Parser.parse(bytes, isPartial);
  const completeBoxesOffset = completeMp4BoxesOffset(bytes, isPartial);
  const parsedMp4 = inspectMp4(bytes.subarray(0, completeBoxesOffset));

  segment.boxes = segment.boxes || {};

  // An ISO BMFF media segment is defined in this specification as one optional Segment
  // Type Box (styp) followed by a single Movie Fragment Box (moof) followed by one or
  // more Media Data Boxes (mdat). If the Segment Type Box is not present, the segment
  // must conform to the brands listed in the File Type Box (ftyp) in the initialization
  // segment.
  // https://w3c.github.io/media-source/isobmff-byte-stream-format.html
  let mdats = [];

  parsedMp4.forEach((box) => {
    if (box.type === 'styp') {
      segment.boxes.styp = box;
      segment.boxes.styp.rawData = rawDataForBox(bytes, 'styp');
    }
    if (box.type === 'moof') {
      segment.boxes.moof = box;
      segment.boxes.moof.rawData = rawDataForBox(bytes, 'moof');
    }
    if (box.type === 'sidx') {
      segment.boxes.sidx = box;
      segment.boxes.sidx.rawData = rawDataForBox(bytes, 'sidx');
    }
    if (box.type === 'mdat') {
      box.rawData = rawDataForBox(bytes, 'mdat');
      if (box.rawData.length === box.size) {
        mdats.push(box);
      }
    }
  });

  let resultBytes = new Uint8Array();

  if (segment.boxes.styp && segment.boxes.moof && mdats.length) {
    const totalBytes = segment.boxes.styp.rawData.length +
      segment.boxes.sidx.rawData.length +
      segment.boxes.moof.rawData.length +
      mdats.reduce((acc, mdat) => { acc += mdat.rawData.length; return acc; }, 0);
    let offset = 0;

    resultBytes = new Uint8Array(totalBytes);

    resultBytes.set(segment.boxes.styp.rawData);
    offset += segment.boxes.styp.rawData.length;
    resultBytes.set(segment.boxes.sidx.rawData, offset);
    offset += segment.boxes.sidx.rawData.length;
    resultBytes.set(segment.boxes.moof.rawData, offset);
    mdats.forEach((mdat) => {
      resultBytes.set(mdat, offset);
      offset += mdat.length;
    });
  }

  if (resultBytes.length !== 0) {
    console.log(resultBytes);
    dataFn(segment, {
      data: resultBytes,
      // TODO
      timingInfo: {
      }
    });
  }

  // const startTime = probeMp4StartTime(bytes, segment.map.bytes);

  // dataFn(segment, {
  //   data: bytes,
  //   // TODO
  //   timingInfo: {
  //     start: startTime
  //   }
  // });
  // doneFn(null, segment, {});

  return completeBoxesOffset;
};

const handleDecryptedBytes = ({
  segment,
  bytes,
  isPartial,
  dataFn,
  doneFn
}) => {
  if (segment.map) {
    return parseMp4AndNotify({
      segment,
      bytes,
      isPartial,
      dataFn,
      doneFn
    });
  }

  // ts
  transmuxAndNotify({
    segment,
    bytes,
    isPartial,
    dataFn,
    doneFn
  });

  // TODO: check that the transmuxer can handle any amount of partial data
  return bytes.byteLength;
};

const transmuxAndNotify = ({
  segment,
  bytes,
  isPartial,
  dataFn,
  doneFn
}) => {
  transmux({
    bytes: bytes.buffer,
    transmuxer: segment.transmuxer,
    audioAppendStart: segment.audioAppendStart,
    gopsToAlignWith: segment.gopsToAlignWith,
    isPartial,
    onData: (result) => {
      dataFn(segment, result);
    },
    onTrackInfo: (trackInfo) => {
      // TODO don't use simpleSegment for trackInfo, or pass it along
      segment.trackInfo = trackInfo;
    },
    onDone: (result) => {
      // TODO better handling
      if (!result.audioTimingInfo && !result.videoTimingInfo) {
        // no data yet
        return;
      }
      // TODO
      if (!doneFn) {
        return;
      }
      // TODO pass less than result
      doneFn(null, segment, result);
    }
  });
};

/**
 * Load all resources and does any processing necessary for a media-segment
 *
 * Features:
 *   decrypts the media-segment if it has a key uri and an iv
 *   aborts *all* requests if *any* one request fails
 *
 * The segment object, at minimum, has the following format:
 * {
 *   resolvedUri: String,
 *   [transmuxer]: Object,
 *   [byterange]: {
 *     offset: Number,
 *     length: Number
 *   },
 *   [key]: {
 *     resolvedUri: String
 *     [byterange]: {
 *       offset: Number,
 *       length: Number
 *     },
 *     iv: {
 *       bytes: Uint32Array
 *     }
 *   },
 *   [map]: {
 *     resolvedUri: String,
 *     [byterange]: {
 *       offset: Number,
 *       length: Number
 *     },
 *     [bytes]: Uint8Array
 *   }
 * }
 * ...where [name] denotes optional properties
 *
 * @param {Function} xhr - an instance of the xhr wrapper in xhr.js
 * @param {Object} xhrOptions - the base options to provide to all xhr requests
 * @param {WebWorker} decryptionWorker - a WebWorker interface to AES-128
 *                                       decryption routines
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} progressFn - a callback that receives progress events from the main
 *                                segment's xhr request
 * @param {Function} dataFn - a callback that receives data from the main segment's xhr
 *                            request, transmuxed if needed
 * @param {Function} doneFn - a callback that is executed only once all requests have
 *                            succeeded or failed
 * @returns {Function} a function that, when invoked, immediately aborts all
 *                     outstanding requests
 */
export const mediaSegmentRequest = (xhr,
                                    xhrOptions,
                                    decryptionWorker,
                                    segment,
                                    progressFn,
                                    dataFn,
                                    doneFn) => {
  const activeXhrs = [];
  const finishProcessingFn = waitForCompletion(
    activeXhrs, decryptionWorker, dataFn, doneFn);

  // optionally, request the decryption key
  if (segment.key) {
    const keyRequestOptions = videojs.mergeOptions(xhrOptions, {
      uri: segment.key.resolvedUri,
      responseType: 'arraybuffer'
    });
    const keyRequestCallback = handleKeyResponse(segment, finishProcessingFn);
    const keyXhr = xhr(keyRequestOptions, keyRequestCallback);

    activeXhrs.push(keyXhr);
  }

  // optionally, request the associated media init segment
  if (segment.map &&
    !segment.map.bytes) {
    const initSegmentOptions = videojs.mergeOptions(xhrOptions, {
      uri: segment.map.resolvedUri,
      responseType: 'arraybuffer',
      headers: segmentXhrHeaders(segment.map)
    });
    const initSegmentRequestCallback = handleInitSegmentResponse(segment,
                                                                 finishProcessingFn);
    const initSegmentXhr = xhr(initSegmentOptions, initSegmentRequestCallback);

    activeXhrs.push(initSegmentXhr);
  }

  const segmentRequestOptions = videojs.mergeOptions(xhrOptions, {
    uri: segment.resolvedUri,
    // set to text to allow for partial responses, conversion to ArrayBuffer happens later
    responseType: 'text',
    headers: segmentXhrHeaders(segment),
    beforeSend: (xhrObject) => {
      // XHR binary charset opt by Marcus Granado 2006 [http://mgran.blogspot.com]
      // makes the browser pass through the "text" unparsed
      xhrObject.overrideMimeType('text/plain; charset=x-user-defined');
    }
  });
  const segmentRequestCallback = handleSegmentResponse(segment, finishProcessingFn);
  const segmentXhr = xhr(segmentRequestOptions, segmentRequestCallback);

  segmentXhr.addEventListener('progress',
    handleProgress(segment, progressFn, dataFn));
  activeXhrs.push(segmentXhr);

  return () => abortAll(activeXhrs);
};
