'use strict';

var assert = require('assert');
var storage = require('./response-storage.js');

function response(textLength) {
  var items = Array.from({ length: 50 }, function(_, index) {
    var type = index < 8 ? 'text' : (index < 11 ? 'number' : 'pass_fail');
    return {
      id: 'i1720000000000abcd' + index,
      label: 'Routine vehicle safety inspection item ' + index,
      type: type,
      photoRequired: false,
      value: type === 'text' ? 'x'.repeat(textLength) : (type === 'number' ? '123' : 'pass'),
      note: '',
      sides: [],
      photoCount: 0,
      mediaFileIds: [],
      gdItemPhotoIds: [],
      itemPhotos: []
    };
  });
  return {
    type: 'ChecklistResponse',
    id: 'resp-1720000000000',
    clientBuild: 'v20.9',
    templateId: 'cl-1720000000000',
    templateName: 'Daily 50 Point Vehicle Check',
    tripType: 'pre',
    driverId: 'driver-1',
    driverName: 'Example Driver',
    deviceId: 'device-1',
    deviceName: 'Vehicle 123 - AB12 CDE',
    submittedAt: '2026-09-11T12:00:00.000Z',
    overallStatus: 'pass',
    flaggedCount: 0,
    photoCount: 4,
    photoStorageVersion: 2,
    photoUploadStatus: 'complete',
    capturedPhotoCount: 4,
    storedPhotoCount: 4,
    photoPendingCount: 0,
    photoFailedCount: 0,
    photoManifest: ['front', 'left', 'right', 'rear'].map(function(slot) {
      return {
        key: 'walkaround:' + slot,
        kind: 'walkaround',
        slot: slot,
        mediaFileId: 'm'.repeat(32),
        gdFileId: 'g'.repeat(40),
        state: 'ready',
        status: 'Available',
        error: ''
      };
    }),
    driveArchiveRequired: true,
    driveArchiveStatus: 'complete',
    driveArchivedPhotoCount: 4,
    mediaFileIds: ['m'.repeat(32)],
    gdFileIds: ['g'.repeat(40)],
    signoff: null,
    items: items
  };
}

var ordinary = response(50);
assert(storage.serializedLength(ordinary) > 9500, 'fixture must reproduce the old size rejection');
var ordinaryPlan = storage.buildPlan(ordinary);
assert.strictEqual(ordinaryPlan.mode, 'single');
assert(storage.serializedLength(ordinaryPlan.response) <= storage.DEFAULT_SAFE_LENGTH);
assert.strictEqual(ordinaryPlan.response.items.length, 50);
assert.strictEqual(ordinaryPlan.response.items[0].value.length, 50);
assert(!Object.prototype.hasOwnProperty.call(ordinaryPlan.response.items[0], 'photoRequired'));
assert(!Object.prototype.hasOwnProperty.call(ordinaryPlan.response.items[0], 'itemPhotos'));
assert(!Object.prototype.hasOwnProperty.call(ordinaryPlan.response, 'gdFileIds'));
assert.strictEqual(storage.buildPlan(ordinary, null, true).mode, 'multipart');

var oversized = response(1000);
var multipart = storage.buildPlan(oversized);
assert.strictEqual(multipart.mode, 'multipart');
assert(multipart.parts.length > 1);
multipart.parts.forEach(function(part) {
  assert(storage.serializedLength(part) <= storage.DEFAULT_SAFE_LENGTH);
});

var root = JSON.parse(JSON.stringify(multipart.completeRoot));
root.partAddInDataIds = multipart.parts.map(function(_, index) { return 'part-' + index; });
var parts = multipart.parts.map(function(part, index) {
  return Object.assign({ _addInDataId: 'part-' + index }, part);
});
var assembled = storage.reassemble(root, parts);
assert(assembled.complete, assembled.reason);
assert.strictEqual(assembled.response.items.length, 50);

root.driveArchiveStatus = 'partial';
root.photoManifest[0].gdFileId = 'updated-drive-id';
assert(storage.reassemble(root, parts).complete, 'valid later root updates must not invalidate item parts');
assert(!storage.reassemble(root, parts.slice(1)).complete, 'missing part must remain incomplete');

var alteredRoot = JSON.parse(JSON.stringify(root));
alteredRoot.driverName = 'Different driver';
assert(!storage.reassemble(alteredRoot, parts).complete, 'immutable root metadata must be protected');
var duplicatePartIds = JSON.parse(JSON.stringify(root));
duplicatePartIds.partAddInDataIds[1] = duplicatePartIds.partAddInDataIds[0];
assert(!storage.reassemble(duplicatePartIds, parts).complete, 'part ids must be complete and unique');

var signedResponse = response(1000);
signedResponse.signoff = {
  version: 1,
  signeeName: 'Original signee',
  signedAtUtc: '2026-09-11T12:05:00.000Z',
  localDate: '2026-09-11',
  timezoneOffsetMinutes: -60,
  acknowledgementVersion: 1,
  acknowledgementText: 'I acknowledge this submission.',
  cardMediaFileId: 'media-signoff',
  archiveStatus: 'pending'
};
var signedPlan = storage.buildPlan(signedResponse);
var signedRoot = JSON.parse(JSON.stringify(signedPlan.completeRoot));
signedRoot.partAddInDataIds = signedPlan.parts.map(function(_, index) { return 'signed-part-' + index; });
var signedParts = signedPlan.parts.map(function(part, index) {
  return Object.assign({ _addInDataId: 'signed-part-' + index }, part);
});
assert(storage.reassemble(signedRoot, signedParts).complete);
signedRoot.signoff.signeeName = 'Changed signee';
assert(!storage.reassemble(signedRoot, signedParts).complete, 'signed identity must be protected by the root hash');

var tampered = JSON.parse(JSON.stringify(parts));
tampered[0].items[0].value = 'changed';
assert(!storage.reassemble(root, tampered).complete, 'changed part must fail its hash check');

var reordered = JSON.parse(JSON.stringify(parts));
var firstItem = reordered[0].items[0];
reordered[0].items[0] = { value: firstItem.value, type: firstItem.type, label: firstItem.label, id: firstItem.id };
assert.strictEqual(storage.partHash(reordered[0].items), reordered[0].partHash, 'property order must not change a part hash');

console.log(JSON.stringify({
  oldLength: storage.serializedLength(ordinary),
  compactLength: storage.serializedLength(ordinaryPlan.response),
  multipartLength: storage.serializedLength(storage.compactResponse(oversized)),
  partCount: multipart.parts.length,
  maxPartLength: Math.max.apply(null, multipart.parts.map(storage.serializedLength))
}));
