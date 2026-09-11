(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChecklistResponseStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var DEFAULT_SAFE_LENGTH = 8500;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function serializedLength(value) {
    return JSON.stringify(value).length;
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function(key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
  }

  function hashString(value) {
    var hash = 2166136261;
    var text = String(value == null ? '' : value);
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  function partHash(items) {
    return hashString(stableStringify(items || []));
  }

  function compactResponse(response) {
    var compact = clone(response || {});
    var hasManifest = compact.photoStorageVersion === 2
      && Array.isArray(compact.photoManifest)
      && compact.photoManifest.length > 0;

    compact.responseStorageVersion = 2;
    delete compact._addInDataId;
    delete compact._partAddInDataIds;
    delete compact.responseHash;

    compact.items = (compact.items || []).map(function(item) {
      var saved = { id: item.id, label: item.label, type: item.type };
      if (item.value != null && item.value !== '') saved.value = item.value;
      if (item.note) saved.note = item.note;
      if (item.sides && item.sides.length) saved.sides = item.sides;
      if (item.photoCount) saved.photoCount = item.photoCount;
      if (!hasManifest && item.mediaFileIds && item.mediaFileIds.length) saved.mediaFileIds = item.mediaFileIds;
      if (!hasManifest && item.itemMediaFileIds && item.itemMediaFileIds.length) saved.itemMediaFileIds = item.itemMediaFileIds;
      if (!hasManifest && item.gdItemPhotoIds && item.gdItemPhotoIds.length) saved.gdItemPhotoIds = item.gdItemPhotoIds;
      return saved;
    });

    if (hasManifest) delete compact.mediaFileIds;
    else if (!compact.mediaFileIds || !compact.mediaFileIds.length) delete compact.mediaFileIds;
    if (hasManifest || !compact.gdFileIds || !compact.gdFileIds.length) delete compact.gdFileIds;
    if (!compact.signoff) delete compact.signoff;

    if (hasManifest) {
      compact.photoManifest = compact.photoManifest.map(function(entry) {
        var saved = { key: entry.key, kind: entry.kind };
        if (entry.slot) saved.slot = entry.slot;
        if (entry.itemId) saved.itemId = entry.itemId;
        if (typeof entry.index === 'number' && entry.index !== 0) saved.index = entry.index;
        if (entry.mediaFileId) saved.mediaFileId = entry.mediaFileId;
        if (entry.gdFileId) saved.gdFileId = entry.gdFileId;
        if (entry.state) saved.state = entry.state;
        if (entry.status && entry.status !== 'Available' && entry.status !== 'Unknown') saved.status = entry.status;
        if (entry.error) saved.error = entry.error;
        return saved;
      });
    } else if (!compact.photoManifest || !compact.photoManifest.length) {
      delete compact.photoManifest;
    }

    return compact;
  }

  function makePart(submissionId, index, count, items) {
    return {
      type: 'ChecklistResponsePart',
      responseStorageVersion: 2,
      submissionId: submissionId,
      partIndex: index,
      partCount: count,
      partHash: partHash(items),
      items: items
    };
  }

  function rootIntegrityPayload(rootRecord) {
    return {
      type: rootRecord.type,
      id: rootRecord.id,
      clientBuild: rootRecord.clientBuild,
      templateId: rootRecord.templateId,
      templateName: rootRecord.templateName,
      tripType: rootRecord.tripType,
      driverId: rootRecord.driverId,
      driverName: rootRecord.driverName,
      deviceId: rootRecord.deviceId,
      deviceName: rootRecord.deviceName,
      submittedAt: rootRecord.submittedAt,
      overallStatus: rootRecord.overallStatus,
      flaggedCount: rootRecord.flaggedCount,
      photoCount: rootRecord.photoCount,
      photoStorageVersion: rootRecord.photoStorageVersion,
      capturedPhotoCount: rootRecord.capturedPhotoCount,
      signoff: rootRecord.signoff ? {
        version: rootRecord.signoff.version,
        signeeName: rootRecord.signoff.signeeName,
        signedAtUtc: rootRecord.signoff.signedAtUtc,
        localDate: rootRecord.signoff.localDate,
        timezoneOffsetMinutes: rootRecord.signoff.timezoneOffsetMinutes,
        acknowledgementVersion: rootRecord.signoff.acknowledgementVersion,
        acknowledgementText: rootRecord.signoff.acknowledgementText,
        cardMediaFileId: rootRecord.signoff.cardMediaFileId
      } : null,
      responseStorageVersion: rootRecord.responseStorageVersion,
      partCount: rootRecord.partCount,
      partsHash: rootRecord.partsHash,
      responseHash: rootRecord.responseHash
    };
  }

  function buildPlan(response, safeLength, forceMultipart) {
    var limit = safeLength || DEFAULT_SAFE_LENGTH;
    var compact = compactResponse(response);
    var responseHash = hashString(stableStringify(compact));
    var singleResponse = clone(compact);
    singleResponse.responseHash = responseHash;
    if (!forceMultipart && serializedLength(singleResponse) <= limit) {
      return { mode: 'single', response: singleResponse, parts: [] };
    }
    if (compact.photoStorageVersion !== 2) {
      throw new Error('Multipart checklist storage requires photo storage version 2');
    }

    var groups = [];
    var current = [];
    (compact.items || []).forEach(function(item) {
      var candidate = current.concat([item]);
      if (serializedLength(makePart(compact.id, groups.length, 9999, candidate)) <= limit) {
        current = candidate;
        return;
      }
      if (!current.length) throw new Error('A single checklist item exceeds the safe storage limit');
      groups.push(current);
      current = [item];
      if (serializedLength(makePart(compact.id, groups.length, 9999, current)) > limit) {
        throw new Error('A single checklist item exceeds the safe storage limit');
      }
    });
    if (current.length) groups.push(current);
    if (!groups.length) throw new Error('Checklist metadata exceeds the safe storage limit');

    var parts = groups.map(function(items, index) {
      return makePart(compact.id, index, groups.length, items);
    });
    var rootRecord = clone(compact);
    rootRecord.items = [];
    rootRecord.multipartStatus = 'uploading';
    rootRecord.partCount = parts.length;
    rootRecord.partAddInDataIds = [];
    rootRecord.partsHash = hashString(parts.map(function(part) { return part.partHash; }).join(':'));
    rootRecord.responseHash = responseHash;
    rootRecord.rootHash = hashString(stableStringify(rootIntegrityPayload(rootRecord)));
    if (serializedLength(rootRecord) > limit) throw new Error('Checklist summary exceeds the safe storage limit');

    var completeRoot = clone(rootRecord);
    completeRoot.multipartStatus = 'complete';
    completeRoot.partAddInDataIds = parts.map(function() { return 'x'.repeat(80); });
    if (serializedLength(completeRoot) > limit) throw new Error('Completed checklist summary exceeds the safe storage limit');
    completeRoot.partAddInDataIds = [];
    return {
      mode: 'multipart',
      response: compact,
      root: rootRecord,
      completeRoot: completeRoot,
      parts: parts
    };
  }

  function reassemble(rootRecord, partRecords) {
    if (!rootRecord || rootRecord.multipartStatus !== 'complete') {
      return { complete: false, reason: 'Submission is not committed' };
    }
    var expectedCount = rootRecord.partCount || 0;
    var expectedIds = rootRecord.partAddInDataIds || [];
    var uniqueIds = expectedIds.filter(function(id, index) { return id && expectedIds.indexOf(id) === index; });
    if (!rootRecord.rootHash
        || rootRecord.rootHash !== hashString(stableStringify(rootIntegrityPayload(rootRecord)))
        || expectedIds.length !== expectedCount
        || uniqueIds.length !== expectedCount) {
      return { complete: false, reason: 'Submission root validation failed' };
    }
    var candidates = (partRecords || []).filter(function(part) {
      if (!part || part.type !== 'ChecklistResponsePart' || part.submissionId !== rootRecord.id) return false;
      if (expectedIds.length && expectedIds.indexOf(part._addInDataId) === -1) return false;
      return true;
    }).sort(function(a, b) { return a.partIndex - b.partIndex; });

    if (!expectedCount || candidates.length !== expectedCount) {
      return { complete: false, reason: 'Submission parts are missing' };
    }
    for (var i = 0; i < candidates.length; i++) {
      var part = candidates[i];
      if (part.partIndex !== i || part.partCount !== expectedCount || part.partHash !== partHash(part.items)) {
        return { complete: false, reason: 'Submission part validation failed' };
      }
    }
    var combinedHash = hashString(candidates.map(function(part) { return part.partHash; }).join(':'));
    if (combinedHash !== rootRecord.partsHash) {
      return { complete: false, reason: 'Submission part set validation failed' };
    }

    var response = clone(rootRecord);
    response.items = [];
    candidates.forEach(function(part) { response.items = response.items.concat(part.items || []); });
    response._partAddInDataIds = candidates.map(function(part) { return part._addInDataId; }).filter(Boolean);
    return { complete: true, response: response };
  }

  return {
    DEFAULT_SAFE_LENGTH: DEFAULT_SAFE_LENGTH,
    serializedLength: serializedLength,
    stableStringify: stableStringify,
    hashString: hashString,
    partHash: partHash,
    rootIntegrityPayload: rootIntegrityPayload,
    compactResponse: compactResponse,
    buildPlan: buildPlan,
    reassemble: reassemble
  };
});
