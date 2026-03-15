require('dotenv').config();
const { pool } = require('./config/database');

pool.query(
  'SELECT id, subscription_status, subscription_tier, deleted_at FROM users WHERE id = $1',
  ['8573d101-959e-409c-b402-9b70fe7e5c5b']
).then(r => {
  console.log(r.rows[0]);
  pool.end();
}).catch(e => {
  console.log('ERROR:', e.message);
  pool.end();
});
