// test-email.js
const AWS = require('aws-sdk');

const ses = new AWS.SES({
  region: 'eu-central-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

async function sendTestEmail() {
  try {
    const params = {
      Source: 'contact@suretalknow.com',
      Destination: {
        ToAddresses: ['contact@suretalknow.com'] // Send to yourself first
      },
      Message: {
        Subject: {
          Data: 'Test email from AWS SES'
        },
        Body: {
          Text: {
            Data: 'This is a test email from AWS SES. If you receive this, SES is working!'
          }
        }
      }
    };

    const result = await ses.sendEmail(params).promise();
    console.log('✅ Email sent successfully:', result.MessageId);
  } catch (error) {
    console.error('❌ Error sending email:', error.message);
    
    if (error.code === 'MessageRejected') {
      console.log('\n⚠️  Your SES account is likely in SANDBOX mode.');
      console.log('   You can only send to VERIFIED email addresses.');
      console.log('   Go to SES Console → Verified identities → Add your personal email too.');
    }
  }
}

sendTestEmail();