// Helper: Fire-and-forget sync to IVR DynamoDB via API Gateway
const syncToIvr = async (payload, endpoint) => {
    try {
      await axios.post(
        `${process.env.IVR_API_URL}/${endpoint}`,  // e.g. 'https://iw7yrrz4c6.execute-api.eu-north-1.amazonaws.com/prod/sync-user'
        payload,
        {
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.IVR_SYNC_TOKEN}`
          },
          timeout: 3000
        }
      );
      logger.info(`Synced to IVR: ${endpoint}`);
    } catch (err) {
      logger.error(`Sync to IVR failed (non-fatal): ${err.message}`);
    }
  };