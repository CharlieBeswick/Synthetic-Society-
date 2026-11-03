ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_avatar_url_https;
ALTER TABLE accounts ADD CONSTRAINT accounts_avatar_url_https CHECK (
  avatar_url IS NULL OR (char_length(avatar_url) <= 2000 AND avatar_url LIKE 'https://%')
);
