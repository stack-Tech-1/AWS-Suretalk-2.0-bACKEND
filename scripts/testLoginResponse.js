// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-bACKEND\scripts\testLoginResponse.js
const axios = require('axios');

async function testLogin() {
  try {
    console.log('Testing admin login response...');
    
    const response = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'admin@suretalk.com',
      password: 'Admin123!'
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log('\n✅ Full Login Response:');
    console.log(JSON.stringify(response.data, null, 2));
    
    // Check if is_admin is in the response
    if (response.data.data && response.data.data.user) {
      console.log('\n🔍 User object in response:');
      console.log('Has is_admin property?', 'is_admin' in response.data.data.user);
      console.log('is_admin value:', response.data.data.user.is_admin);
      console.log('All properties:', Object.keys(response.data.data.user));
    }
    
    // Decode JWT to check payload
    if (response.data.data.token) {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.decode(response.data.data.token);
      console.log('\n🔍 JWT Decoded Payload:');
      console.log('Has isAdmin property?', 'isAdmin' in decoded);
      console.log('isAdmin value:', decoded.isAdmin);
      console.log('Full JWT payload:', decoded);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testLogin();