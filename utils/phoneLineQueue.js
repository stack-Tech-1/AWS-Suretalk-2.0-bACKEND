// utils/phoneLineQueue.js
// The phone line's own retry queue (DynamoDB table SyncOutbox, eu-central-1): changes made on a call
// that the phone line sends to the app. The retrySyncOutbox Lambda retries them every 2 minutes and
// marks them 'dead' after 10 failures. Reading needs DynamoDB read access (the backend has it);
// retry/dismiss need dynamodb:UpdateItem on the table (lambda-export\phase5 permission script).
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = () => process.env.DYNAMO_SYNC_OUTBOX_TABLE || 'SyncOutbox';
const STATUS_INDEX = 'StatusIndex';

let doc;
const client = () => {
  if (!doc) {
    doc = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.IVR_AWS_REGION || 'eu-central-1',
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
        : undefined,
      maxAttempts: 2,
    }));
  }
  return doc;
};

const EVENT_LABELS = {
  create_user: 'New phone-line account', update_user: 'PIN or phone number change', unsubscribe: 'Unsubscribe',
  create_slot: 'New keypad recording', delete_slot: 'Deleted keypad recording', update_contact: 'Contact change',
  create_will: 'New voice will', delete_will: 'Deleted voice will', create_schedule: 'Scheduled message',
};

const isAccessDenied = (err) => /AccessDenied|not authorized/i.test(`${err?.name} ${err?.message}`);

// Items the phone line gave up on
async function listDead(limit = 200) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await client().send(new QueryCommand({
      TableName: TABLE(), IndexName: STATUS_INDEX,
      KeyConditionExpression: '#s = :dead',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':dead': 'dead' },
      ScanIndexForward: false, ExclusiveStartKey,
    }));
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < limit);
  return items.slice(0, limit).map(i => ({
    id: i.syncId,
    eventType: i.eventType,
    label: EVENT_LABELS[i.eventType] || i.eventType,
    phone: i.payload?.userId || null,
    payload: i.payload,
    attempts: i.attempts || 0,
    error: i.errorMessage || null,
    createdAt: i.createdAt || null,
    lastAttemptAt: i.lastAttemptAt || null,
  }));
}

// Counts by status and by event type (the table is small; a projected scan is cheap)
async function counts() {
  const byStatus = {}, byEvent = {};
  let ExclusiveStartKey;
  do {
    const r = await client().send(new ScanCommand({
      TableName: TABLE(), ProjectionExpression: '#s, eventType',
      ExpressionAttributeNames: { '#s': 'status' }, ExclusiveStartKey,
    }));
    for (const i of r.Items || []) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      const e = byEvent[i.eventType] = byEvent[i.eventType] || { label: EVENT_LABELS[i.eventType] || i.eventType };
      e[i.status] = (e[i.status] || 0) + 1;
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { byStatus, byEvent };
}

// Put a dead item back in the queue; retrySyncOutbox sends it again within about 2 minutes
async function retry(syncId, adminId) {
  await client().send(new UpdateCommand({
    TableName: TABLE(), Key: { syncId },
    UpdateExpression: 'SET #s = :pending, attempts = :zero, lastAttemptAt = :null, errorMessage = :null, retriedBy = :admin, retriedAt = :now',
    ConditionExpression: '#s = :dead',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'pending', ':dead': 'dead', ':zero': 0, ':null': null, ':admin': String(adminId), ':now': new Date().toISOString() },
  }));
}

async function dismiss(syncId, reason, adminId) {
  await client().send(new UpdateCommand({
    TableName: TABLE(), Key: { syncId },
    UpdateExpression: 'SET #s = :dismissed, resolvedNote = :note, resolvedBy = :admin, resolvedAt = :now',
    ConditionExpression: '#s = :dead',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':dismissed': 'dismissed', ':dead': 'dead', ':note': reason, ':admin': String(adminId), ':now': new Date().toISOString() },
  }));
}

module.exports = { listDead, counts, retry, dismiss, isAccessDenied, EVENT_LABELS };
