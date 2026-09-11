'use strict';

var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var storage = require('./response-storage.js');

function extractFunction(source, name) {
  var start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Could not find ' + name);
  var open = source.indexOf('{', start);
  var depth = 0;
  for (var i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('Could not parse ' + name);
}

function oversizedResponse() {
  return {
    type: 'ChecklistResponse',
    id: 'resp-interrupted',
    clientBuild: 'v20.9',
    templateId: 'template-1',
    templateName: 'Interruption Test',
    driverId: 'driver-1',
    driverName: 'Driver',
    deviceId: 'device-1',
    deviceName: 'Vehicle',
    submittedAt: '2026-09-11T12:00:00.000Z',
    overallStatus: 'pass',
    flaggedCount: 0,
    photoCount: 0,
    photoStorageVersion: 2,
    photoUploadStatus: 'complete',
    capturedPhotoCount: 0,
    storedPhotoCount: 0,
    photoPendingCount: 0,
    photoFailedCount: 0,
    photoManifest: [],
    driveArchiveRequired: true,
    driveArchiveStatus: 'complete',
    driveArchivedPhotoCount: 0,
    mediaFileIds: [],
    items: Array.from({ length: 20 }, function(_, index) {
      return {
        id: 'item-' + index,
        label: 'Observation ' + index,
        type: 'text',
        value: 'x'.repeat(1000),
        note: '',
        sides: [],
        photoCount: 0,
        mediaFileIds: [],
        itemPhotos: []
      };
    })
  };
}

var plan = storage.buildPlan(oversizedResponse());
assert.strictEqual(plan.mode, 'multipart');
assert(plan.parts.length > 1);
assert(!storage.reassemble(plan.root, []).complete, 'uploading root must remain hidden');

var rows = [];
var nextId = 1;
var addCounts = {};
var droppedPartIndex = 1;
var dropInjected = false;
var dropSingle = false;
var singleDropInjected = false;
var failSingleBeforeWrite = false;
var singlePreWriteFailureInjected = false;

function copy(value) { return JSON.parse(JSON.stringify(value)); }

function apiCall(method, params, onSuccess, onError) {
  if (method === 'Get') {
    var matches = params.search && params.search.id
      ? rows.filter(function(row) { return row.id === params.search.id; })
      : rows;
    onSuccess(copy(matches));
    return;
  }
  if (method === 'Add') {
    var details = copy(params.entity.details);
    var key = details.type === 'ChecklistResponsePart'
      ? 'part-' + details.partIndex
      : (details.type === 'IssueStatus' ? 'issue-' + details.itemId : (details.multipartStatus ? 'root' : 'single'));
    addCounts[key] = (addCounts[key] || 0) + 1;
    if (key === 'single' && failSingleBeforeWrite && !singlePreWriteFailureInjected) {
      singlePreWriteFailureInjected = true;
      onError(new Error('Connection dropped before single server write'));
      return;
    }
    var id = 'row-' + nextId++;
    rows.push({ id: id, details: details });
    if (key === 'single' && dropSingle && !singleDropInjected) {
      singleDropInjected = true;
      onError(new Error('Connection dropped after single server write'));
      return;
    }
    if (details.type === 'ChecklistResponsePart' && details.partIndex === droppedPartIndex && !dropInjected) {
      dropInjected = true;
      onError(new Error('Connection dropped after server write'));
      return;
    }
    onSuccess(id);
    return;
  }
  if (method === 'Set') {
    var row = rows.find(function(entry) { return entry.id === params.entity.id; });
    if (!row) { onError(new Error('Missing root')); return; }
    row.details = copy(params.entity.details);
    onSuccess(null);
    return;
  }
  onError(new Error('Unexpected method ' + method));
}

var source = fs.readFileSync('index_landingpage.html', 'utf8');
var context = {
  ADDIN_ID: 'addin-1',
  RESPONSE_TEXT_MAX_LENGTH: 4000,
  SIGNATURE_DRAW_PADDING: 10,
  ChecklistResponseStorage: storage,
  apiCall: apiCall,
  pqDatabaseKey: function() { return 'demo'; },
  responseBatchPut: function(batch, callback) { callback(true); },
  responseBatchAcquire: function(batchKey, callback) { callback(true); },
  responseBatchRelease: function(batchKey, callback) { if (callback) callback(); },
  _responseWorkerId: 'test-worker',
  upRender: function() {},
  _toQueue: [],
  pqFlushToStore: function(rec, rootId, issueIds, callback) { callback(context._toQueue.length); },
  setTimeout: function(callback) { callback(); },
  console: console
};
vm.createContext(context);
vm.runInContext(extractFunction(source, 'getResponseStorageRows'), context);
vm.runInContext(extractFunction(source, 'verifySavedResponse'), context);
vm.runInContext(extractFunction(source, 'deliverSingleResponse'), context);
vm.runInContext(extractFunction(source, 'deliverStoredResponse'), context);
vm.runInContext(extractFunction(source, 'deliverResponseBatch'), context);
vm.runInContext(extractFunction(source, 'ensureResponseSideEffects'), context);
vm.runInContext(extractFunction(source, 'signaturePointForEvent'), context);

var signatureCanvas = {
  getBoundingClientRect: function() { return { left: 100, top: 50, width: 300, height: 200 }; }
};
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(context.signaturePointForEvent(signatureCanvas, { clientX: 101, clientY: 51 }))),
  { x: 10, y: 10 }
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(context.signaturePointForEvent(signatureCanvas, { clientX: 399, clientY: 249 }))),
  { x: 290, y: 190 }
);

var completed = false;
context.deliverStoredResponse({ batchKey: 'multipart-batch', databaseKey: 'demo', plan: plan }, function(rootId, response) {
  completed = true;
  assert(rootId);
  assert.strictEqual(response.items.length, 20);
}, function(err) {
  throw new Error('Delivery did not recover: ' + err);
});

assert(completed, 'delivery should complete after reconciliation');
assert(dropInjected, 'test must inject the part 2 interruption');
assert.strictEqual(addCounts.root, 1, 'root must not be duplicated');
plan.parts.forEach(function(part) {
  assert.strictEqual(addCounts['part-' + part.partIndex], 1, 'part must not be duplicated');
});
var root = rows.find(function(row) { return row.details.type === 'ChecklistResponse'; });
assert.strictEqual(root.details.multipartStatus, 'complete');
assert.strictEqual(root.details.partAddInDataIds.length, plan.parts.length);

dropSingle = true;
var singlePlan = storage.buildPlan({
  type: 'ChecklistResponse',
  id: 'single-interrupted',
  submittedAt: '2026-09-11T12:00:00.000Z',
  items: [{ id: 'item-1', label: 'Item', type: 'pass_fail', value: 'pass' }]
});
var singleCompleted = false;
context.deliverStoredResponse({ batchKey: 'single-batch', databaseKey: 'demo', plan: singlePlan, started: false }, function(id) {
  singleCompleted = true;
  assert(id);
}, function(err) {
  throw new Error('Single delivery did not reconcile: ' + err);
});
assert(singleCompleted);
assert(singleDropInjected);
assert.strictEqual(addCounts.single, 1, 'ambiguous single write must not be duplicated');
var ambiguousSingleWrites = addCounts.single;

dropSingle = false;
failSingleBeforeWrite = true;
var retryPlan = storage.buildPlan({
  type: 'ChecklistResponse',
  id: 'single-retry',
  submittedAt: '2026-09-11T12:00:00.000Z',
  items: [{ id: 'item-2', label: 'Item', type: 'pass_fail', value: 'pass' }]
});
var writesBeforeRetryTest = addCounts.single;
var retryCompleted = false;
context.deliverStoredResponse({ batchKey: 'single-retry-batch', databaseKey: 'demo', plan: retryPlan, started: false }, function() {
  retryCompleted = true;
}, function(err) {
  throw new Error('Single pre-write failure did not retry: ' + err);
});
assert(retryCompleted);
assert(singlePreWriteFailureInjected);
assert.strictEqual(addCounts.single - writesBeforeRetryTest, 2, 'pre-write failure must retry Add exactly once');

var sideEffectResponse = {
  id: 'resp-side-effects',
  deviceName: 'Vehicle',
  driverName: 'Driver',
  templateName: 'Checklist',
  submittedAt: '2026-09-11T12:00:00.000Z',
  photoManifest: [{ kind: 'item', itemId: 'failed-item', mediaFileId: 'media-1', gdFileId: 'drive-1' }],
  items: [{ id: 'failed-item', label: 'Failed item', type: 'pass_fail', value: 'fail', note: 'Observed issue' }]
};
var queuedPhotos = [{ manifestKey: 'item:failed-item:0', dataUrl: 'data:image/jpeg;base64,AA==' }];
var sideEffectsCompleted = 0;
context.ensureResponseSideEffects(sideEffectResponse, root.id, queuedPhotos, function(ok) {
  assert(ok);
  sideEffectsCompleted++;
});
context.ensureResponseSideEffects(sideEffectResponse, root.id, queuedPhotos, function(ok) {
  assert(ok);
  sideEffectsCompleted++;
});
assert.strictEqual(sideEffectsCompleted, 2);
assert.strictEqual(addCounts['issue-failed-item'], 1, 'issue retry must be idempotent');

console.log(JSON.stringify({
  recoveredAfterPart: droppedPartIndex + 1,
  rootWrites: addCounts.root,
  partWrites: plan.parts.map(function(part) { return addCounts['part-' + part.partIndex]; }),
  committed: root.details.multipartStatus === 'complete',
  singleWritesAfterLostResponse: ambiguousSingleWrites,
  preWriteRetryAttempts: addCounts.single - writesBeforeRetryTest,
  issueWritesAfterRetry: addCounts['issue-failed-item']
}));
