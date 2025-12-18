// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\utils\s3Storage.js
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const multerS3 = require('multer-s3');

// Initialize S3
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  signatureVersion: 'v4'
});

// S3 buckets configuration
const BUCKETS = {
  VOICE_NOTES: process.env.AWS_S3_BUCKET_VOICE_NOTES || 'suertalk-voice-notes',
  LEGACY_VAULT: process.env.AWS_S3_BUCKET_LEGACY_VAULT || 'suertalk-legacy-vault',
  WILLS: process.env.AWS_S3_BUCKET_WILLS || 'suertalk-legacy-wills'
};

// Generate unique S3 key
const generateS3Key = (userId, fileName, bucketType) => {
  const timestamp = Date.now();
  const extension = fileName.split('.').pop();
  const uuid = uuidv4();
  
  let prefix;
  switch (bucketType) {
    case 'LEGACY_VAULT':
      prefix = `vault/${userId}/permanent`;
      break;
    case 'WILLS':
      prefix = `wills/${userId}`;
      break;
    default:
      prefix = `voice-notes/${userId}`;
  }
  
  return `${prefix}/${timestamp}-${uuid}.${extension}`;
};

// Generate pre-signed URL for upload
const generateUploadUrl = async (userId, fileName, fileType, bucketType = 'VOICE_NOTES') => {
  const bucket = BUCKETS[bucketType];
  const key = generateS3Key(userId, fileName, bucketType);
  
  const params = {
    Bucket: bucket,
    Key: key,
    ContentType: fileType,
    Expires: parseInt(process.env.AWS_S3_UPLOAD_EXPIRY) || 3600,
    Metadata: {
      userId: userId.toString(),
      uploadedAt: new Date().toISOString()
    }
  };

  // Add encryption for legacy vault buckets
  if (bucketType === 'LEGACY_VAULT' || bucketType === 'WILLS') {
    params.ServerSideEncryption = 'aws:kms';
    params.SSEKMSKeyId = process.env.AWS_KMS_KEY_ID; // Optional: Specify KMS key
  }

  const uploadUrl = await s3.getSignedUrlPromise('putObject', params);
  
  return {
    uploadUrl,
    key,
    bucket,
    expiresIn: params.Expires
  };
};

// Generate pre-signed URL for download/playback
const generateDownloadUrl = async (key, bucket, expiresIn = 3600) => {
  const params = {
    Bucket: bucket,
    Key: key,
    Expires: expiresIn
  };

  return await s3.getSignedUrlPromise('getObject', params);
};

// Configure multer for direct S3 uploads
const uploadToS3 = (bucketType = 'VOICE_NOTES') => {
  const bucket = BUCKETS[bucketType];
  
  return multer({
    storage: multerS3({
      s3: s3,
      bucket: bucket,
      acl: 'private',
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: function (req, file, cb) {
        const userId = req.user.id;
        const key = generateS3Key(userId, file.originalname, bucketType);
        cb(null, key);
      },
      metadata: function (req, file, cb) {
        cb(null, {
          userId: req.user.id,
          originalName: file.originalname,
          uploadedAt: new Date().toISOString()
        });
      }
    }),
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB limit
      files: 1
    },
    fileFilter: function (req, file, cb) {
      // Accept audio files only
      if (file.mimetype.startsWith('audio/')) {
        cb(null, true);
      } else {
        cb(new Error('Only audio files are allowed'));
      }
    }
  });
};

// Copy object to different storage class (for lifecycle management)
const changeStorageClass = async (key, bucket, storageClass) => {
  const params = {
    Bucket: bucket,
    CopySource: `${bucket}/${key}`,
    Key: key,
    StorageClass: storageClass,
    MetadataDirective: 'COPY'
  };

  await s3.copyObject(params).promise();
  return true;
};

// Delete object from S3
const deleteFromS3 = async (key, bucket) => {
  const params = {
    Bucket: bucket,
    Key: key
  };

  await s3.deleteObject(params).promise();
  return true;
};

// Get object metadata
const getObjectMetadata = async (key, bucket) => {
  const params = {
    Bucket: bucket,
    Key: key
  };

  const metadata = await s3.headObject(params).promise();
  return metadata;
};

module.exports = {
  BUCKETS,
  generateUploadUrl,
  generateDownloadUrl,
  uploadToS3,
  changeStorageClass,
  deleteFromS3,
  getObjectMetadata
};