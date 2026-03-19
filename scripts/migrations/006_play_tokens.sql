CREATE TABLE IF NOT EXISTS play_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token UUID NOT NULL UNIQUE,
  scheduled_message_id UUID REFERENCES scheduled_messages(id) ON DELETE CASCADE,
  voice_note_id UUID REFERENCES voice_notes(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  play_count INTEGER DEFAULT 0,
  last_played TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_play_tokens_token ON play_tokens(token);
CREATE INDEX IF NOT EXISTS idx_play_tokens_expiry ON play_tokens(expires_at);
