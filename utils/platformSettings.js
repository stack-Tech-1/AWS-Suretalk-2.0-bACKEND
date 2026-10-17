// Platform-wide switches set from the admin Settings page (stored in system_settings).
// Read on almost every request, so values are cached briefly; saving a setting clears the cache
// on this server, and other servers pick it up within CACHE_MS.
const { pool } = require('../config/database');

const CACHE_MS = 15 * 1000;

// The only settings the app actually uses. Anything else in system_settings is ignored, including rows the old
// settings page wrote (they have created_by set) — so a switch someone flipped there can't suddenly take effect.
const PLATFORM_SETTINGS = {
  maintenanceMode:    { category: 'system',   type: 'boolean', default: false },
  maintenanceMessage: { category: 'system',   type: 'string',  default: "We're doing some maintenance and will be back shortly." },
  require2FA:         { category: 'security', type: 'boolean', default: false },
};

let cache = null;

const parse = (raw, type) => {
  if (type === 'boolean') return raw === 'true' || raw === true;
  return raw ?? '';
};

async function loadAll() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.values;
  const values = Object.fromEntries(Object.entries(PLATFORM_SETTINGS).map(([k, d]) => [k, d.default]));
  try {
    const keys = Object.keys(PLATFORM_SETTINGS);
    const result = await pool.query(
      `SELECT DISTINCT ON (setting_key) setting_key, setting_value
       FROM system_settings
       WHERE setting_key = ANY($1)
         AND category IN ('system', 'security')
         AND created_by IS NULL
       ORDER BY setting_key, updated_at DESC NULLS LAST`,
      [keys]
    );
    for (const row of result.rows) {
      const def = PLATFORM_SETTINGS[row.setting_key];
      if (def) values[row.setting_key] = parse(row.setting_value, def.type);
    }
  } catch (error) {
    // Fail open: a settings read error must never take the whole site down
    console.error('Platform settings read failed:', error.message);
    if (cache) return cache.values;
  }
  cache = { at: Date.now(), values };
  return values;
}

async function saveSetting(key, value) {
  const def = PLATFORM_SETTINGS[key];
  if (!def) throw new Error(`Unknown setting: ${key}`);
  const stored = def.type === 'boolean' ? String(!!value) : String(value ?? '').slice(0, 500);
  // Update-then-insert rather than ON CONFLICT: the table's unique key differs between
  // databases created by different setup scripts, so this works with either.
  const updated = await pool.query(
    `UPDATE system_settings
     SET setting_value = $3, setting_type = $4, updated_at = CURRENT_TIMESTAMP
     WHERE category = $1 AND setting_key = $2 AND created_by IS NULL`,
    [def.category, key, stored, def.type]
  );
  if (updated.rowCount === 0) {
    // created_by stays NULL: these are platform-wide, and the column cascades on user deletion
    await pool.query(
      `INSERT INTO system_settings (category, setting_key, setting_value, setting_type)
       VALUES ($1, $2, $3, $4)`,
      [def.category, key, stored, def.type]
    );
  }
  cache = null;
  return parse(stored, def.type);
}

module.exports = {
  PLATFORM_SETTINGS,
  getPlatformSettings: loadAll,
  saveSetting,
};
