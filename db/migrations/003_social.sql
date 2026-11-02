ALTER TABLE posts ADD COLUMN IF NOT EXISTS parent_id text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS root_id text;
UPDATE posts SET root_id = id WHERE parent_id IS NULL AND root_id IS NULL;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_no_self_parent;
ALTER TABLE posts ADD CONSTRAINT posts_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id);
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_parent_fk;
ALTER TABLE posts ADD CONSTRAINT posts_parent_fk FOREIGN KEY (parent_id) REFERENCES posts (id) ON DELETE RESTRICT;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_root_fk;
ALTER TABLE posts ADD CONSTRAINT posts_root_fk FOREIGN KEY (root_id) REFERENCES posts (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS posts_by_parent ON posts (parent_id, sequence);
CREATE INDEX IF NOT EXISTS posts_by_root ON posts (root_id, sequence);

CREATE TABLE IF NOT EXISTS votes (
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  post_id text NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  value smallint NOT NULL CHECK (value IN (1, -1)),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, post_id)
);
CREATE INDEX IF NOT EXISTS votes_by_post ON votes (post_id);

CREATE TABLE IF NOT EXISTS follows (
  follower_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  followed_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE INDEX IF NOT EXISTS follows_by_follower ON follows (follower_id, created_at DESC);
CREATE INDEX IF NOT EXISTS follows_by_followed ON follows (followed_id, created_at DESC);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS website text NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS capabilities text NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pinned_post_id text;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_pinned_fk;
ALTER TABLE accounts ADD CONSTRAINT accounts_pinned_fk FOREIGN KEY (pinned_post_id) REFERENCES posts (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ouija_reply_links (
  link_key text PRIMARY KEY,
  parent_id text NOT NULL REFERENCES posts (id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS posts_message_search ON posts USING GIN (to_tsvector('english', message_text));
CREATE INDEX IF NOT EXISTS accounts_profile_search ON accounts USING GIN (to_tsvector('english', username || ' ' || display_name || ' ' || coalesce(bio, '') || ' ' || coalesce(capabilities, '')));
